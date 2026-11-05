/**
 * `where` to SQL, shared by Query and Delete. Every predicate is two-valued, so NOT and `every` read plainly.
 * Field values are encoded with the field's JSON codec and compared as jsonb; absent fields are SQL NULL, JSON null is
 * `'null'`. Times compare as their columns. One reader serves a struct at every depth: an Object's payload, its stored
 * reference, and struct values inside them.
 */
import { Effect, Schema, type SchemaAST } from "effect"
import type { Statement } from "effect/sql"
import type { ValidationFailed } from "./errors.ts"
import { absent } from "./absent.ts"
import { encode, entriesOf, givenWhere, invalid, isRecord } from "./input.ts"
import type { ResolvedModel, ResolvedType } from "./resolve.ts"
import { umweltSql } from "./storage/tables.ts"
import { timeColumn } from "./times.ts"
import { domainsOf, isNumeric, kindsOf, payloadOf, shapeOf, type Domain } from "./values.ts"

type Fragment = Statement.Fragment
type Scope = { readonly model: ResolvedModel; readonly sql: Statement.Constructor; readonly depth: number }
/** A condition, and JSON the value it reads contains whenever it holds, `undefined` when none is known. */
type Condition = { readonly sql: Fragment; readonly implied: unknown }
/**
 * Containment of the Object's value, given JSON a value inside it holds; it goes beside a condition implying it, so the
 * payload index serves the condition. `undefined` where the index cannot use it: below a negation, inside elements.
 */
type Contain = ((json: unknown) => Fragment) | undefined
/**
 * What a level of `where` reads: a jsonb value holding one of `members`. On an Object, its Type adds relation slots,
 * and its row, unless the value is a stored reference, adds times.
 */
type Reading = {
    readonly name: string
    readonly members: readonly SchemaAST.Objects[]
    readonly value: Fragment
    readonly contain: Contain
    readonly type: ResolvedType | undefined
    readonly row: Fragment | undefined
}
/** A field or element a filter reads. */
type Place = { readonly name: string; readonly domain: Domain; readonly value: Fragment; readonly contain: Contain }

/**
 * Numeric value of a stored JSON value: a number, or a string holding one, like `"Infinity"` from `Schema.Number` or the
 * text of `Schema.NumberFromString`; SQL NULL for any other value. The cast is guarded inside CASE, see SQL Null And Guards.
 */
export const numericOf = (sql: Statement.Constructor, json: Fragment) =>
    sql`(case when pg_input_is_valid(${json} #>> '{}', 'numeric') then (${json} #>> '{}')::numeric end)`

/** `column` is one of `values`, passed as one jsonb array parameter: lists of any length, one bind parameter. */
export const within = (sql: Statement.Constructor, column: Fragment, values: readonly string[]) =>
    sql`${column} in (select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`

/** Elements of a jsonb array; any other value, JSON null included, has none. */
export const elementsOf = (sql: Statement.Constructor, json: Fragment) =>
    sql`jsonb_array_elements(case when jsonb_typeof(${json}) = 'array' then ${json} else '[]'::jsonb end)`

/**
 * Condition on `row`, an alias of `umwelt_object` holding an Object of `type`, like `o`. `where` is taken as given
 * once, so every walk below sees the same keys. Fails with ValidationFailed on keys the types do not allow, empty
 * levels, and values that do not fit the field.
 */
export const compileWhere = (model: ResolvedModel, type: ResolvedType, where: unknown, row: Fragment) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const given = yield* givenWhere(where, `where on ${type.name}`)
        return yield* objectWhere({ model, sql, depth: 0 }, type, given, sql`${row}.payload`, row)
    })

/** Where on an Object of `type` whose payload or stored reference is `value`. */
const objectWhere = (scope: Scope, type: ResolvedType, where: unknown, value: Fragment, row: Fragment | undefined) => {
    const contain = (json: unknown) => scope.sql`${value} @> ${JSON.stringify(json)}::jsonb`
    const reading = { name: type.name, members: payloadOf(type), value, contain, type, row }
    return Effect.map(whereOf(scope, reading, where), (condition) => lifted(scope, contain, condition))
}

const lifted = (scope: Scope, contain: Contain, condition: Condition) =>
    contain === undefined || condition.implied === undefined
        ? condition.sql
        : scope.sql`(${contain(condition.implied)} and ${condition.sql})`

const opaque = (sql: Fragment): Condition => ({ sql, implied: undefined })

const and = (scope: Scope, conditions: readonly Condition[]): Condition => ({
    sql: scope.sql.and(conditions.map(({ sql }) => sql)),
    implied: conditions.reduce<unknown>((implied, condition) => merged(implied, condition.implied), undefined)
})

/** One branch implies what it implies; of several, each takes its containment beside it. */
const or = (scope: Scope, contain: Contain, conditions: readonly Condition[]): Condition => {
    const [only, ...rest] = conditions
    if (only !== undefined && rest.length === 0) return only
    return opaque(scope.sql.or(conditions.map((condition) => lifted(scope, contain, condition))))
}

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value)

/** JSON contained by any value containing both: objects merge, arrays join; a conflict drops, which only weakens. */
const merged = (left: unknown, right: unknown): unknown => {
    if (left === undefined) return right
    if (right === undefined) return left
    if (isList(left) && isList(right)) return [...left, ...right]
    if (!isRecord(left) || !isRecord(right)) return JSON.stringify(left) === JSON.stringify(right) ? left : undefined
    return Object.fromEntries(
        [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => {
            const both = merged(left[key], right[key])
            return both === undefined ? [] : [[key, both]]
        })
    )
}

const whereOf = (scope: Scope, reading: Reading, where: unknown): Effect.Effect<Condition, ValidationFailed> =>
    Effect.gen(function* () {
        const entries = isRecord(where) ? entriesOf(where) : []
        if (entries.length === 0) return yield* invalid(`where on ${reading.name} needs at least one condition`)
        const conditions = yield* Effect.forEach(entries, ([key, value]) =>
            typeof key === "symbol" ? timeFilter(scope, reading, key, value) : conditionOf(scope, reading, key, value)
        )
        return and(scope, conditions)
    })

const listOf = (scope: Scope, reading: Reading, key: string, value: unknown) =>
    Array.isArray(value) && value.length > 0
        ? Effect.forEach(value, (where) => whereOf(scope, reading, where))
        : invalid(`${key} on ${reading.name} takes a non-empty list`)

/** Absence before relation slots, so an optional relation field takes `Umwelt.absent` like any field. */
const conditionOf = (
    scope: Scope,
    reading: Reading,
    key: string,
    value: unknown
): Effect.Effect<Condition, ValidationFailed> => {
    const { sql } = scope
    if (key === "AND") return Effect.map(listOf(scope, reading, key, value), (parts) => and(scope, parts))
    if (key === "OR")
        return Effect.map(listOf(scope, reading, key, value), (parts) => or(scope, reading.contain, parts))
    if (key === "NOT") {
        const negated = whereOf(scope, { ...reading, contain: undefined }, value)
        return Effect.map(negated, (where) => opaque(sql`(not ${where.sql})`))
    }
    const domain = domainsOf(reading.members).get(key)
    if (domain === undefined) return invalid(`${reading.name} has no field ${key}`)
    const contain = reading.contain
    const place: Place = {
        name: `${reading.name}.${key}`,
        domain,
        value: sql`(${reading.value} -> ${key}::text)`,
        contain: contain === undefined ? undefined : (json) => contain({ [key]: json })
    }
    if (value === absent) {
        return domain.optional
            ? Effect.succeed(opaque(sql`(${place.value} is null)`))
            : invalid(`${place.name} is required: no absent`)
    }
    const slot = reading.type?.slots.get(key)
    if (slot !== undefined) return Effect.map(relationFilter(scope, slot, key, value, place.value), opaque)
    return Effect.map(fieldFilter(scope, place, value), (condition) => ({
        sql: condition.sql,
        implied: condition.implied === undefined ? undefined : { [key]: condition.implied }
    }))
}

// ---------------------------------------------------------------- filters

const operators = ["equals", "lt", "gt", "contains", "is", "isNot", "some", "every", "none"] as const
type Operator = (typeof operators)[number]
const isOperator = (key: string | symbol): key is Operator => operators.some((operator) => operator === key)

/**
 * One value's filter, on a field, an element, or a time: a bare value means `equals`; operators at least one, all must
 * hold; `in` is `equals` on any of its items, none for an empty list. `test` turns one operator and its operand into a
 * condition.
 */
const filterOf = (
    scope: Scope,
    place: Pick<Place, "name" | "contain">,
    value: unknown,
    test: (operator: Operator, operand: unknown) => Effect.Effect<Condition, ValidationFailed>
): Effect.Effect<Condition, ValidationFailed> => {
    const { sql } = scope
    if (!isRecord(value)) return test("equals", value)
    const entries = entriesOf(value)
    if (entries.length === 0) return invalid(`${place.name} needs at least one operator`)
    return Effect.map(
        Effect.forEach(entries, ([operator, operand]) => {
            switch (operator) {
                case "in":
                    return Array.isArray(operand)
                        ? Effect.map(
                              Effect.forEach(operand, (item) => test("equals", item)),
                              (items) => (items.length === 0 ? opaque(sql`false`) : or(scope, place.contain, items))
                          )
                        : invalid(`${place.name}.in takes a list`)
                default:
                    return isOperator(operator)
                        ? test(operator, operand)
                        : invalid(`${place.name} has no operator ${String(operator)}`)
            }
        }),
        (conditions) => and(scope, conditions)
    )
}

const signs: Partial<Record<Operator, "=" | "<" | ">">> = { equals: "=", lt: "<", gt: ">" }

/** Time key on an Object's row: Dates only. The columns are never null. */
const timeFilter = (scope: Scope, reading: Reading, key: symbol, value: unknown) => {
    const { sql } = scope
    const column = timeColumn(key)
    if (column === undefined) return invalid(`where on ${reading.name} takes no key ${String(key)}`)
    if (reading.row === undefined) return invalid(`${String(key)} is a time of Objects, not of ${reading.name}`)
    const time = sql`${reading.row}.${sql.literal(column)}`
    return filterOf(scope, { name: String(key), contain: undefined }, value, (operator, operand) => {
        const sign = signs[operator]
        if (sign === undefined) return invalid(`${String(key)} takes no ${operator}`)
        return operand instanceof Date && !Number.isNaN(operand.getTime())
            ? Effect.succeed(opaque(sql`${time} ${sql.literal(sign)} ${operand.toISOString()}::timestamptz`))
            : invalid(`${String(key)} takes a Date`)
    })
}

/** Payload field or element: a scalar, or operators, as its domain allows. */
const fieldFilter = (scope: Scope, place: Place, value: unknown): Effect.Effect<Condition, ValidationFailed> => {
    if (!isRecord(value) && !isScalar(value)) return invalid(`${place.name} takes a scalar or operators`)
    return filterOf(scope, place, value, (operator, operand) => {
        switch (operator) {
            case "equals":
                return equals(scope, place, operand)
            case "lt":
            case "gt":
                return compare(scope, place, operator, operand)
            case "contains":
                return contains(scope, place, operand)
            case "is":
            case "isNot":
                return structFilter(scope, place, operator, operand)
            case "some":
            case "every":
            case "none":
                return listFilter(scope, place, operator, operand)
        }
    })
}

const isScalar = (value: unknown) => value === null || value instanceof Date || typeof value !== "object"

/**
 * An operand read in each encoding of the domain that takes it, each reading once; when none takes it, the first
 * encoding's failure.
 */
const readings = <A>(place: Place, operand: unknown, read: (json: unknown, ast: SchemaAST.AST) => A) => {
    const encoded = (ast: SchemaAST.AST) =>
        encode(Schema.toCodecJson(Schema.make<Schema.Codec<unknown, unknown>>(ast)), operand, place.name, {
            disableChecks: true
        })
    return Effect.flatMap(
        Effect.partition(place.domain.encodings, (ast) => Effect.map(encoded(ast), (json) => read(json, ast))),
        ([found, [failure]]) =>
            found.length === 0 && failure !== undefined
                ? Effect.fail(failure)
                : Effect.succeed([...new Map(found.map((reading) => [JSON.stringify(reading), reading])).values()])
    )
}

/** Equal in one of the encodings. `place.value` is SQL NULL only where the equality is false: two-valued. */
const equals = (scope: Scope, place: Place, operand: unknown) => {
    const { sql } = scope
    if (operand === absent) return invalid(`${place.name} takes a value`)
    return Effect.map(
        readings(place, operand, (json) => json),
        (jsons) =>
            or(
                scope,
                place.contain,
                jsons.map((json) => ({
                    sql: sql`coalesce(${place.value} = ${JSON.stringify(json)}::jsonb, false)`,
                    implied: json
                }))
            )
    )
}

/** `lt` and `gt` on numbers, strings, and Dates, also mixed; numbers by numeric value, whatever their stored form. */
const compare = (scope: Scope, place: Place, operator: "lt" | "gt", operand: unknown) => {
    const kinds = kindsOf(place.domain.encodings)
    if (kinds === undefined || kinds.size === 0) return invalid(`${place.name} takes no ${operator}`)
    if (operand === null) return invalid(`${place.name}.${operator} takes a value`)
    const { sql } = scope
    const sign = sql.literal(operator === "lt" ? "<" : ">")
    const read = (json: unknown, ast: SchemaAST.AST) => ({ json, numeric: isNumeric(kindsOf([ast])) })
    return Effect.map(readings(place, operand, read), (found) =>
        opaque(
            sql.or(
                found.map(({ json, numeric }) => {
                    const value = sql`${JSON.stringify(json)}::jsonb`
                    return numeric
                        ? sql`coalesce(${numericOf(sql, place.value)} ${sign} ${numericOf(sql, value)}, false)`
                        : sql`coalesce(jsonb_typeof(${place.value}) = jsonb_typeof(${value}) and ${place.value} ${sign} ${value}, false)`
                })
            )
        )
    )
}

/** `contains` on strings only. */
const contains = (scope: Scope, place: Place, operand: unknown) => {
    const { sql } = scope
    const kinds = kindsOf(place.domain.encodings)
    if (kinds?.size !== 1 || !kinds.has("string")) return invalid(`${place.name} takes no contains`)
    return typeof operand === "string"
        ? Effect.succeed(
              opaque(
                  sql`coalesce(jsonb_typeof(${place.value}) = 'string' and (${place.value} #>> '{}') like ${like(operand)}, false)`
              )
          )
        : invalid(`${place.name}.contains takes a string`)
}

const like = (text: string) => `%${text.replaceAll(/[\\%_]/gu, (character) => `\\${character}`)}%`

/** `is`, `isNot` on structs: a where over the value, which only an object matches; `isNot` is `not is`. */
const structFilter = (scope: Scope, place: Place, operator: "is" | "isNot", where: unknown) => {
    const { sql } = scope
    const shape = shapeOf(place.domain)
    if (shape.kind !== "struct") return invalid(`${place.name} takes no ${operator}: it holds more than structs`)
    const reading: Reading = {
        name: place.name,
        members: shape.members,
        value: place.value,
        contain: operator === "is" ? place.contain : undefined,
        type: undefined,
        row: undefined
    }
    return Effect.map(whereOf(scope, reading, where), (condition) => {
        const matched = sql`(coalesce(jsonb_typeof(${place.value}) = 'object', false) and ${condition.sql})`
        return operator === "is" ? { sql: matched, implied: condition.implied } : opaque(sql`(not ${matched})`)
    })
}

/**
 * `some`, `every`, `none` on arrays, over their elements: an element holding structs takes `is`'s where, any other
 * what a field holding it takes. What `some` implies of an element, the array contains.
 */
const listFilter = (scope: Scope, place: Place, operator: "some" | "every" | "none", filter: unknown) => {
    const { sql } = scope
    const shape = shapeOf(place.domain)
    if (shape.kind !== "array") return invalid(`${place.name} takes no ${operator}: it holds more than arrays`)
    const item = sql.literal(`v${scope.depth}`)
    const inner = { ...scope, depth: scope.depth + 1 }
    const element = { name: `${place.name}[]`, domain: shape.elements, value: sql`${item}.value`, contain: undefined }
    const matched =
        shapeOf(shape.elements).kind === "struct"
            ? structFilter(inner, element, "is", filter)
            : fieldFilter(inner, element, filter)
    const items = sql`${elementsOf(sql, place.value)} ${item}`
    return Effect.map(matched, (condition): Condition => {
        switch (operator) {
            case "some":
                return {
                    sql: sql`exists (select 1 from ${items} where ${condition.sql})`,
                    implied: condition.implied === undefined ? undefined : [condition.implied]
                }
            case "every":
                return opaque(sql`(not exists (select 1 from ${items} where not ${condition.sql}))`)
            case "none":
                return opaque(sql`(not exists (select 1 from ${items} where ${condition.sql}))`)
        }
    })
}

// ---------------------------------------------------------------- relations

const operatorsByCard = { one: ["is", "isNot"], many: ["some", "every", "none"] } as const

/** Field names and time keys a where reads, through AND, OR, and NOT. */
const fieldsOf = (where: unknown): readonly (string | symbol)[] =>
    isRecord(where)
        ? entriesOf(where).flatMap(([key, value]) =>
              key === "AND" || key === "OR"
                  ? (Array.isArray(value) ? value : []).flatMap(fieldsOf)
                  : key === "NOT"
                    ? fieldsOf(value)
                    : [key]
          )
        : []

const relationFilter = (
    scope: Scope,
    slot: { readonly target: string; readonly card: "one" | "many" },
    key: string,
    value: unknown,
    reference: Fragment
) => {
    const target = scope.model.types.get(slot.target)
    if (target === undefined) return Effect.die(new Error(`relation ${key} targets unknown Type ${slot.target}`))
    const allowed: readonly string[] = operatorsByCard[slot.card]
    const entries = isRecord(value) ? entriesOf(value) : []
    if (entries.length === 0) return invalid(`${key} takes ${allowed.join(", ")} with the target's where`)
    const inner = { ...scope, depth: scope.depth + 1 }
    return Effect.map(
        Effect.forEach(entries, ([operator, where]) => {
            if (typeof operator === "symbol" || !allowed.includes(operator))
                return invalid(`${key} has no relation filter ${String(operator)}`)
            const identityOnly = fieldsOf(where).every(
                (field) => typeof field === "string" && target.uniqueKey.includes(field)
            )
            return slot.card === "one"
                ? oneFilter(inner, target, operator, where, reference, identityOnly)
                : manyFilter(inner, target, operator, where, reference, identityOnly)
        }),
        scope.sql.and
    )
}

/** `is`, `isNot`: Identity fields only read the stored reference; other fields read the existing target. */
const oneFilter = (
    scope: Scope,
    target: ResolvedType,
    operator: string,
    where: unknown,
    reference: Fragment,
    identityOnly: boolean
) => {
    const { sql } = scope
    const row = sql.literal(`t${scope.depth}`)
    const matched = identityOnly
        ? objectWhere(scope, target, where, reference, undefined)
        : Effect.map(
              objectWhere(scope, target, where, sql`${row}.payload`, row),
              (condition) =>
                  sql`exists (select 1 from umwelt_object ${row} where ${row}.type = ${target.name}::text and ${row}.identity = ${reference} and ${condition})`
          )
    return Effect.map(matched, (condition) => (operator === "is" ? condition : sql`(not ${condition})`))
}

/** `some`, `every`, `none` over the list's references, or over the existing targets they name. */
const manyFilter = (
    scope: Scope,
    target: ResolvedType,
    operator: string,
    where: unknown,
    references: Fragment,
    identityOnly: boolean
) => {
    const { sql } = scope
    const item = sql.literal(`e${scope.depth}`)
    const row = sql.literal(`t${scope.depth}`)
    const items = sql`${elementsOf(sql, references)} ${item}`
    const rows = identityOnly
        ? items
        : sql`${items} join umwelt_object ${row} on ${row}.type = ${target.name}::text and ${row}.identity = ${item}.value`
    const matched = identityOnly
        ? objectWhere(scope, target, where, sql`${item}.value`, undefined)
        : objectWhere(scope, target, where, sql`${row}.payload`, row)
    return Effect.map(matched, (condition) =>
        operator === "some"
            ? sql`exists (select 1 from ${rows} where ${condition})`
            : operator === "every"
              ? sql`(not exists (select 1 from ${rows} where not ${condition}))`
              : sql`(not exists (select 1 from ${rows} where ${condition}))`
    )
}
