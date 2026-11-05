/**
 * `where` to SQL, shared by Query and Delete. Every predicate is two-valued, so NOT and `every` read plainly.
 * Field values are encoded with the field's JSON codec and compared as jsonb; absent fields are SQL NULL, JSON null is
 * `'null'`. Times compare as their columns.
 */
import { Effect, SchemaAST, type Schema } from "effect"
import type { Statement } from "effect/sql"
import type { ValidationFailed } from "./errors.ts"
import { absent } from "./absent.ts"
import { encode, entriesOf, givenWhere, invalid, isRecord, optionalFields } from "./input.ts"
import type { ResolvedModel, ResolvedType } from "./resolve.ts"
import { umweltSql } from "./storage/tables.ts"
import { timeColumn } from "./times.ts"

type Fragment = Statement.Fragment
type Scope = { readonly model: ResolvedModel; readonly sql: Statement.Constructor; readonly depth: number }
/** What a level of `where` reads: a jsonb expression, and the Object's row unless that is a stored reference. */
type Base = { readonly json: Fragment; readonly row: Fragment | undefined }
type Kind = "number" | "string" | "date"
/** A payload field: JSON codec, and the kinds of its values when operators may compare them. */
type Field = { readonly codec: Schema.Codec<unknown, unknown>; readonly kinds: ReadonlySet<Kind> | undefined }

const isDate = (ast: SchemaAST.Declaration) => {
    const representation = ast.annotations?.["representation"]
    return isRecord(representation) && representation["id"] === "effect/schema/Date"
}

const valueKinds = (values: readonly unknown[]): readonly Kind[] | undefined =>
    values.every((value) => typeof value === "string" || typeof value === "number")
        ? values.map((value) => (typeof value === "string" ? "string" : "number"))
        : undefined

/** Kinds of the values a schema holds; `Schema.suspend` is followed once per path. */
const kinds = (ast: SchemaAST.AST, entered: ReadonlySet<SchemaAST.AST>): readonly Kind[] | undefined => {
    if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) return ["string"]
    if (SchemaAST.isNumber(ast)) return ["number"]
    if (SchemaAST.isLiteral(ast)) return valueKinds([ast.literal])
    if (SchemaAST.isEnum(ast)) return valueKinds(ast.enums.map(([, value]) => value))
    if (SchemaAST.isNull(ast)) return []
    if (SchemaAST.isDeclaration(ast)) return isDate(ast) ? ["date"] : undefined
    if (SchemaAST.isSuspend(ast)) return entered.has(ast) ? undefined : kinds(ast.thunk(), new Set([...entered, ast]))
    if (!SchemaAST.isUnion(ast)) return undefined
    const members = ast.types.map((member) => kinds(member, entered))
    return members.every((member) => member !== undefined) ? members.flat() : undefined
}

/**
 * Kinds of a field's non-null values, each number, string, or Date; `undefined` when some value is none of them.
 * Decides what `lt`, `gt`, and `contains` take, and what `orderBy` sorts by.
 */
export const kindsOf = (type: ResolvedType, field: string): ReadonlySet<Kind> | undefined => {
    const properties = SchemaAST.isObjects(type.payload.ast) ? type.payload.ast.propertySignatures : []
    const property = properties.find((signature) => signature.name === field)
    const found = property === undefined ? undefined : kinds(SchemaAST.toType(property.type), new Set())
    return found === undefined ? undefined : new Set(found)
}

/** Fields holding numbers only: they sort and compare by numeric value, whatever their stored form, see Query. */
export const isNumeric = (kinds: ReadonlySet<Kind> | undefined) => kinds?.size === 1 && kinds.has("number")

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

/** Field `key` of `base`, a jsonb expression holding a payload or a reference. */
const at = (scope: Scope, base: Fragment, key: string) => scope.sql`(${base} -> ${key}::text)`

/**
 * Condition on `row`, an alias of `umwelt_object` holding an Object of `type`, like `o`. `where` is taken as given
 * once, so every walk below sees the same keys. Fails with ValidationFailed on keys the types do not allow, empty
 * levels, and values that do not fit the field.
 */
export const compileWhere = (model: ResolvedModel, type: ResolvedType, where: unknown, row: Fragment) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const given = yield* givenWhere(where, `where on ${type.name}`)
        return yield* whereOf({ model, sql, depth: 0 }, type, given, { json: sql`${row}.payload`, row })
    })

const whereOf = (
    scope: Scope,
    type: ResolvedType,
    where: unknown,
    base: Base
): Effect.Effect<Fragment, ValidationFailed> =>
    Effect.gen(function* () {
        const entries = isRecord(where) ? entriesOf(where) : []
        if (entries.length === 0) return yield* invalid(`where on ${type.name} needs at least one condition`)
        const conditions = yield* Effect.forEach(entries, ([key, value]) =>
            typeof key === "symbol"
                ? timeFilter(scope, type, key, value, base)
                : conditionOf(scope, type, key, value, base)
        )
        return scope.sql.and(conditions)
    })

const listOf = (scope: Scope, type: ResolvedType, key: string, value: unknown, base: Base) =>
    Array.isArray(value) && value.length > 0
        ? Effect.forEach(value, (where) => whereOf(scope, type, where, base))
        : invalid(`${key} on ${type.name} takes a non-empty list`)

const conditionOf = (scope: Scope, type: ResolvedType, key: string, value: unknown, base: Base) => {
    const { sql } = scope
    if (key === "AND") return Effect.map(listOf(scope, type, key, value, base), sql.and)
    if (key === "OR") return Effect.map(listOf(scope, type, key, value, base), sql.or)
    if (key === "NOT") return Effect.map(whereOf(scope, type, value, base), (where) => sql`(not ${where})`)
    if (value === absent) {
        return optionalFields(type).has(key)
            ? Effect.succeed(sql`(${at(scope, base.json, key)} is null)`)
            : invalid(`${type.name}.${key} is required: no absent`)
    }
    const slot = type.slots.get(key)
    if (slot !== undefined) return relationFilter(scope, slot, key, value, at(scope, base.json, key))
    const codec = type.fields.get(key)
    if (codec === undefined) return invalid(`${type.name} has no field ${key}`)
    return fieldFilter(scope, { codec, kinds: kindsOf(type, key) }, key, value, base.json)
}

// ---------------------------------------------------------------- filters

type Operator = "equals" | "lt" | "gt" | "contains"

/**
 * One value's filter, on a field or a time: a bare value means `equals`; operators at least one, all must hold; `in`
 * is `equals` on any of its items, none for an empty list. `test` turns one operator and its operand into a condition.
 */
const filterOf = (
    scope: Scope,
    key: string,
    value: unknown,
    test: (operator: Operator, operand: unknown) => Effect.Effect<Fragment, ValidationFailed>
): Effect.Effect<Fragment, ValidationFailed> => {
    const { sql } = scope
    if (!isRecord(value)) return test("equals", value)
    const entries = entriesOf(value)
    if (entries.length === 0) return invalid(`${key} needs at least one operator`)
    return Effect.map(
        Effect.forEach(entries, ([operator, operand]) => {
            switch (operator) {
                case "in":
                    return Array.isArray(operand)
                        ? Effect.map(
                              Effect.forEach(operand, (item) => test("equals", item)),
                              (items) => (items.length === 0 ? sql`false` : sql.or(items))
                          )
                        : invalid(`${key}.in takes a list`)
                case "equals":
                case "lt":
                case "gt":
                case "contains":
                    return test(operator, operand)
                default:
                    return invalid(`${key} has no operator ${String(operator)}`)
            }
        }),
        sql.and
    )
}

/** Time key on the Object's row: Dates only, no `contains`. The columns are never null. */
const timeFilter = (scope: Scope, type: ResolvedType, key: symbol, value: unknown, base: Base) => {
    const { sql } = scope
    const column = timeColumn(key)
    if (column === undefined) return invalid(`where on ${type.name} takes no key ${String(key)}`)
    if (base.row === undefined) return Effect.die(new Error(`${String(key)} read from a stored reference`))
    const time = sql`${base.row}.${sql.literal(column)}`
    const signs = { equals: "=", lt: "<", gt: ">" } as const
    return filterOf(scope, String(key), value, (operator, operand) => {
        if (operator === "contains") return invalid(`${String(key)} takes no contains`)
        return operand instanceof Date && !Number.isNaN(operand.getTime())
            ? Effect.succeed(sql`${time} ${sql.literal(signs[operator])} ${operand.toISOString()}::timestamptz`)
            : invalid(`${String(key)} takes a Date`)
    })
}

/** Payload field: a scalar, or operators, as its kinds allow. */
const fieldFilter = (scope: Scope, field: Field, key: string, value: unknown, base: Fragment) => {
    const { sql } = scope
    if (!isRecord(value) && !isScalar(value)) return invalid(`${key} takes a scalar or operators`)
    const fragment = at(scope, base, key)
    return filterOf(scope, key, value, (operator, operand) => {
        if (operator === "equals") return equals(scope, field, key, operand, base)
        if (!allows(field, operator)) return invalid(`${key} takes no ${operator}`)
        if (operator !== "contains") return compare(scope, field, key, operator, operand, fragment)
        return typeof operand === "string"
            ? Effect.succeed(
                  sql`coalesce(jsonb_typeof(${fragment}) = 'string' and (${fragment} #>> '{}') like ${like(operand)}, false)`
              )
            : invalid(`${key}.contains takes a string`)
    })
}

const isScalar = (value: unknown) => value === null || value instanceof Date || typeof value !== "object"

const encoded = (field: Field, key: string, value: unknown) => encode(field.codec, value, key, { disableChecks: true })

/**
 * Containment beside equality, implied by it, lets the payload index serve equality. `base` is SQL NULL only where
 * the equality is false, so the result stays two-valued.
 */
const equals = (scope: Scope, field: Field, key: string, value: unknown, base: Fragment) => {
    const { sql } = scope
    if (value === absent) return invalid(`${key} takes a value`)
    return Effect.map(
        encoded(field, key, value),
        (json) => sql`(${base} @> ${JSON.stringify({ [key]: json })}::jsonb
            and coalesce(${at(scope, base, key)} = ${JSON.stringify(json)}::jsonb, false))`
    )
}

/** `lt` and `gt` on numbers, strings, and Dates, also mixed; `contains` on strings only. */
const allows = (field: Field, operator: "lt" | "gt" | "contains") =>
    operator === "contains"
        ? field.kinds?.size === 1 && field.kinds.has("string")
        : field.kinds !== undefined && field.kinds.size > 0

const compare = (
    scope: Scope,
    field: Field,
    key: string,
    operator: "lt" | "gt",
    operand: unknown,
    fragment: Fragment
) => {
    if (operand === null) return invalid(`${key}.${operator} takes a value`)
    const { sql } = scope
    const sign = sql.literal(operator === "lt" ? "<" : ">")
    return Effect.map(encoded(field, key, operand), (json) => {
        const value = sql`${JSON.stringify(json)}::jsonb`
        return isNumeric(field.kinds)
            ? sql`coalesce(${numericOf(sql, fragment)} ${sign} ${numericOf(sql, value)}, false)`
            : sql`coalesce(jsonb_typeof(${fragment}) = jsonb_typeof(${value}) and ${fragment} ${sign} ${value}, false)`
    })
}

const like = (text: string) => `%${text.replaceAll(/[\\%_]/gu, (character) => `\\${character}`)}%`

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
        ? whereOf(scope, target, where, { json: reference, row: undefined })
        : Effect.map(
              whereOf(scope, target, where, { json: sql`${row}.payload`, row }),
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
    const base = identityOnly ? { json: sql`${item}.value`, row: undefined } : { json: sql`${row}.payload`, row }
    return Effect.map(whereOf(scope, target, where, base), (condition) =>
        operator === "some"
            ? sql`exists (select 1 from ${rows} where ${condition})`
            : operator === "every"
              ? sql`(not exists (select 1 from ${rows} where not ${condition}))`
              : sql`(not exists (select 1 from ${rows} where ${condition}))`
    )
}
