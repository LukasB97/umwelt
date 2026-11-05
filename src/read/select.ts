/**
 * Reading Objects: one statement per read, one row per root Object, each built as JSON with its includes as correlated
 * subqueries, then decoded through its Type's codec. Aliases are `o`, `c`, `m`, `x` plus depth; `where` uses `t` and `e`.
 */
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/sql"
import type { ValidationFailed } from "../errors.ts"
import type { ResolvedModel } from "../resolve.ts"
import { gatedRead } from "../storage/gate.ts"
import { umweltSql } from "../storage/tables.ts"
import { compileWhere, elementsOf, numericOf, within } from "../where.ts"
import type { Edge, Node, Order, Page } from "./plan.ts"

type Fragment = Statement.Fragment
type Sql = Statement.Constructor
type Scope = { readonly model: ResolvedModel; readonly sql: Sql }
type Built = Effect.Effect<Fragment, ValidationFailed, SqlClient.SqlClient>

/** QueryObject as read; relations hold QueryObject, `null`, or lists of QueryObject. */
export type ReadObject = {
    type: string
    id: string
    createdAt: Date
    changedAt: Date
    payload: unknown
    relations: { [key: string]: unknown }
}

const alias = (sql: Sql, prefix: string, depth: number) => sql.literal(`${prefix}${depth}`)

/**
 * Sort keys: orderBy fields with JSON null as SQL null, times by their column, numbers by numeric value, then list position, then Object ID.
 * `nullable`: only these sort with `nulls last`; the rest keep the default, so a plain index serves both directions.
 */
type Key = { readonly of: (row: Fragment) => Fragment; readonly descending: boolean; readonly nullable: boolean }

const keyOf = (sql: Sql, order: Order): Key => {
    if ("column" in order)
        return { of: (row) => sql`${row}.${sql.literal(order.column)}`, descending: order.descending, nullable: false }
    const value = (row: Fragment) => sql`(${row}.payload -> ${order.field}::text)`
    return {
        of: (row) => (order.numeric ? numericOf(sql, value(row)) : sql`nullif(${value(row)}, 'null'::jsonb)`),
        descending: order.descending,
        nullable: true
    }
}

const keysOf = (sql: Sql, orderBy: readonly Order[]): readonly Key[] => [
    ...orderBy.map((order) => keyOf(sql, order)),
    { of: (row) => sql`${row}.position`, descending: false, nullable: false },
    { of: (row) => sql`${row}.id`, descending: false, nullable: false }
]

const orderOf = (sql: Sql, keys: readonly Key[], row: Fragment) =>
    sql.csv(
        keys.map(
            (key) =>
                sql`${key.of(row)} ${sql.literal(`${key.descending ? "desc" : "asc"}${key.nullable ? " nulls last" : ""}`)}`
        )
    )

/**
 * Rows sorting after the cursor: lexicographic over the keys, null last in both directions. Each key comes with the
 * cursor's value of it, SQL null for an unknown cursor, so nothing follows that. A leading key that is never null also
 * bounds the rows on its own, so an index on it seeks to the cursor instead of reading every row before it.
 */
const afterOf = (sql: Sql, keys: readonly (Key & { readonly cursor: Fragment })[], row: Fragment) => {
    const sign = (key: Key, strict: boolean) => sql.literal(`${key.descending ? "<" : ">"}${strict ? "" : "="}`)
    const seek = keys
        .slice(0, 1)
        .filter((key) => !key.nullable)
        .map((key) => sql`${key.of(row)} ${sign(key, false)} ${key.cursor}`)
    const after = sql.or(
        keys.map((key, index) =>
            sql.and([
                ...keys.slice(0, index).map((before) => sql`${before.of(row)} is not distinct from ${before.cursor}`),
                sql`(${key.cursor} is not null and (${key.of(row)} is null or ${key.of(row)} ${sign(key, true)} ${key.cursor}))`
            ])
        )
    )
    return sql.and([...seek, after])
}

/** Object as JSON: Object ID, its times, stored payload, and included relations. */
const objectOf = (scope: Scope, node: Node, depth: number): Built =>
    Effect.gen(function* () {
        const { sql } = scope
        const self = alias(sql, "o", depth)
        const relations = yield* Effect.forEach(node.edges, (edge) =>
            Effect.map(edgeOf(scope, edge, depth), (value) => sql`jsonb_build_object(${edge.key}::text, ${value})`)
        )
        const merged = relations.length === 0 ? sql`'{}'::jsonb` : sql.join(" || ", false)(relations)
        return sql`jsonb_build_object('id', ${self}.id, 'createdAt', ${self}.created, 'changedAt', ${self}.changed,
            'payload', ${self}.payload, 'relations', ${merged})`
    })

const edgeOf = (scope: Scope, edge: Edge, depth: number): Built =>
    edge.link.kind === "one" ? targetOf(scope, edge, depth) : collectionOf(scope, edge, depth)

/** `one`: the target Object, SQL null when none exists. */
const targetOf = (scope: Scope, edge: Edge, depth: number) => {
    const { sql } = scope
    const parent = alias(sql, "o", depth)
    const self = alias(sql, "o", depth + 1)
    return Effect.map(
        objectOf(scope, edge.node, depth + 1),
        (object) => sql`(select ${object} from umwelt_object ${self}
            where ${self}.type = ${edge.node.type.name}::text
            and ${self}.identity = (${parent}.payload -> ${edge.link.field}::text))`
    )
}

/** Objects of a page as one JSON list, in page order. */
const listOf = (sql: Sql, page: Fragment, depth: number) => {
    const rows = alias(sql, "x", depth)
    return sql`(select coalesce(jsonb_agg(${rows}.o order by ${rows}.n), '[]'::jsonb) from (${page}) ${rows})`
}

const collectionOf = (scope: Scope, edge: Edge, depth: number) => {
    const { sql } = scope
    const candidates = edge.link.kind === "reverse" ? sourcesOf(sql, edge, depth) : membersOf(sql, edge, depth)
    return Effect.map(pageOf(scope, edge.node, candidates, edge.page, depth + 1, edge.page.take), (page) =>
        listOf(sql, page, depth + 1)
    )
}

/** `many`: existing targets, each once, at the position of its first reference. */
const membersOf = (sql: Sql, edge: Edge, depth: number) => {
    const parent = alias(sql, "o", depth)
    const self = alias(sql, "o", depth + 1)
    const member = alias(sql, "m", depth + 1)
    return sql`select ${self}.*, min(${member}.n) as position
        from ${elementsOf(sql, sql`${parent}.payload -> ${edge.link.field}::text`)} with ordinality ${member}(value, n)
        join umwelt_object ${self} on ${self}.type = ${edge.node.type.name}::text and ${self}.identity = ${member}.value
        group by ${self}.id`
}

/** RelationField: Objects of the source Type whose field holds the parent's Identity; containment uses the payload index. */
const sourcesOf = (sql: Sql, edge: Edge, depth: number) => {
    const parent = alias(sql, "o", depth)
    const self = alias(sql, "o", depth + 1)
    const member = alias(sql, "m", depth + 1)
    const { field } = edge.link
    const value = sql`(${self}.payload -> ${field}::text)`
    const [contained, matches] =
        edge.link.kind === "reverse" && edge.link.card === "many"
            ? [
                  sql`jsonb_build_array(${parent}.identity)`,
                  sql`exists (select 1 from ${elementsOf(sql, value)} ${member} where ${member}.value = ${parent}.identity)`
              ]
            : [sql`${parent}.identity`, sql`${value} = ${parent}.identity`]
    return sql`select ${self}.*, 0 as position from umwelt_object ${self}
        where ${self}.type = ${edge.node.type.name}::text
        and ${self}.payload @> jsonb_build_object(${field}::text, ${contained}) and ${matches}`
}

/** Selected Objects of the candidates as rows `o` (JSON) and `n` (rank), filtered, sorted, and paged. */
const pageOf = (scope: Scope, node: Node, candidates: Fragment, page: Page, depth: number, limit: number | undefined) =>
    Effect.gen(function* () {
        const { sql, model } = scope
        const self = alias(sql, "o", depth)
        const keys = keysOf(sql, page.orderBy)
        const order = orderOf(sql, keys, self)
        const object = yield* objectOf(scope, node, depth)
        const where = page.where === undefined ? [] : [yield* compileWhere(model, node.type, page.where, self)]
        const cursor = alias(sql, "c", depth)
        const cursorOf = (key: Key) =>
            sql`(select ${key.of(cursor)} from (${candidates}) ${cursor} where ${cursor}.id = ${page.cursor}::text)`
        const after =
            page.cursor === undefined
                ? []
                : [
                      afterOf(
                          sql,
                          keys.map((key) => ({ ...key, cursor: cursorOf(key) })),
                          self
                      )
                  ]
        return sql`select ${object} as o, row_number() over (order by ${order}) as n
            from (${candidates}) ${self} where ${sql.and([...where, ...after])} order by ${order}
            ${limit === undefined ? sql.literal("") : sql`limit ${limit}`}
            ${page.skip === undefined ? sql.literal("") : sql`offset ${page.skip}`}`
    })

const Raw = Schema.Struct({
    id: Schema.String,
    createdAt: Schema.DateFromString,
    changedAt: Schema.DateFromString,
    payload: Schema.Unknown,
    relations: Schema.Record(Schema.String, Schema.Unknown)
})
const RawList = Schema.Array(Schema.Unknown)

const decode = (node: Node, json: unknown): Effect.Effect<ReadObject, Schema.SchemaError> =>
    Effect.gen(function* () {
        const raw = yield* Schema.decodeUnknownEffect(Raw)(json)
        const payload = yield* Schema.decodeUnknownEffect(node.type.json)(raw.payload, { disableChecks: true })
        const relations = yield* Effect.forEach(node.edges, (edge) =>
            Effect.map(relationOf(edge, raw.relations[edge.key]), (value): [string, unknown] => [edge.key, value])
        )
        return { type: node.type.name, ...raw, payload, relations: Object.fromEntries(relations) }
    })

const decodeList = (node: Node, value: unknown) =>
    Effect.flatMap(Schema.decodeUnknownEffect(RawList)(value), (list) =>
        Effect.forEach(list, (item) => decode(node, item))
    )

const relationOf = (edge: Edge, value: unknown): Effect.Effect<unknown, Schema.SchemaError> => {
    if (edge.link.kind === "one") return value === null ? Effect.succeed(null) : decode(edge.node, value)
    return decodeList(edge.node, value)
}

/**
 * Objects of the root node's Type in page order, `ids` narrowing them for Get; `limit` overrides `take`. Read behind the
 * Model gate in one statement, one row per root Object. Stored content is decoded without schema checks, and fitting no
 * codec is a defect: Write and Deploy keep it valid.
 */
export const select = (
    model: ResolvedModel,
    node: Node,
    page: Page,
    options: { readonly ids?: readonly string[]; readonly limit?: number }
) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const self = alias(sql, "o", 0)
        const narrowed =
            options.ids === undefined ? sql.literal("") : sql`and ${within(sql, sql`${self}.id`, options.ids)}`
        const candidates = sql`select ${self}.*, 0 as position
            from umwelt_object ${self} where ${self}.type = ${node.type.name}::text ${narrowed}`
        const rows = yield* pageOf({ model, sql }, node, candidates, page, 0, options.limit ?? page.take)
        const objects = yield* gatedRead(model, rows)
        return yield* Effect.orDie(Effect.forEach(objects, (object) => decode(node, object)))
    })
