/** Delete: selection by where, ids, or allowAll; blocked deletes. See CONTEXT/client/delete.md. */
import { Effect } from "effect"
import type { SqlClient, SqlError, Statement } from "effect/sql"
import type { DeleteError } from "../api.ts"
import { ReferencedByHost } from "../errors.ts"
import type { ResolvedModel, ResolvedType } from "../resolve.ts"
import { exact, invalid, isRecord, typeOf, type Input } from "../input.ts"
import { guarded } from "../storage/gate.ts"
import { umweltSql } from "../storage/tables.ts"
import { compileWhere, within } from "../where.ts"

type Reference = { readonly type: string; readonly id: string }
type Blocked = {
    readonly object: Reference
    readonly blockedBy: { readonly source: Reference; readonly field: string }[]
}
type Deleted = {
    readonly matched: readonly Reference[]
    readonly deleted: readonly Reference[]
    readonly blocked: readonly Blocked[]
}

const nothing = (): Deleted => ({ matched: [], deleted: [], blocked: [] })

const typesOf = (model: ResolvedModel, value: unknown) =>
    Array.isArray(value)
        ? value.length === 0
            ? invalid("Delete type list must not be empty")
            : Effect.forEach(value, (type) => typeOf(model, type))
        : Effect.map(typeOf(model, value), (type) => [type])

const idsOf = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string")
        ? Effect.succeed(value)
        : invalid("ids must be a non-empty list of Object IDs")

/** Selection as SQL condition on `o`; `undefined` selects nothing. */
const selectionOf = (model: ResolvedModel, types: readonly ResolvedType[], input: Input) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const has = (key: string) => key in input
        const names = within(
            sql,
            sql`o.type`,
            types.map(({ name }) => name)
        )
        if (has("allowAll")) {
            const all = input["allowAll"] === true && !has("ids") && (!has("where") || input["where"] === true)
            return all ? names : yield* invalid("allowAll takes true, beside it only where: true")
        }
        if (has("ids")) {
            if (has("where")) return yield* invalid("Delete takes one selection")
            return sql.and([names, within(sql, sql`o.id`, yield* idsOf(input["ids"]))])
        }
        if (input["where"] === false) return undefined
        if (!isRecord(input["where"])) return yield* invalid("Delete needs where, ids, or allowAll")
        const where = input["where"]
        const conditions = yield* Effect.forEach(types, (type) =>
            Effect.map(compileWhere(model, type, where, sql.literal("o")), (condition) =>
                sql.and([sql`o.type = ${type.name}`, condition])
            )
        )
        return sql.or(conditions)
    })

/** Strict references from Objects outside the selection, per selected Object. */
const blockedOf = (model: ResolvedModel, ids: readonly string[]) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const relations = [...model.types.values()].flatMap((source) =>
            source.relations.filter(({ mode }) => mode === "strict").map((location) => ({ source, location }))
        )
        const rows = yield* Effect.forEach(relations, ({ source, location }) =>
            sql<{ object: string; source: string }>`select distinct t.id as object, s.id as source
                from umwelt_object s, jsonb_path_query(s.payload, ${location.path}::jsonpath) reference,
                    umwelt_object t
                where s.type = ${source.name} and t.type = ${location.target} and t.identity = reference
                and ${within(sql, sql`t.id`, ids)} and not ${within(sql, sql`s.id`, ids)}`.pipe(
                Effect.map((found) =>
                    found.map((row) => ({
                        object: { type: location.target, id: row.object },
                        blocking: { source: { type: source.name, id: row.source }, field: location.field }
                    }))
                )
            )
        )
        const blocked = new Map<string, Blocked>()
        for (const { object, blocking } of rows.flat()) {
            const entry = blocked.get(object.id) ?? { object, blockedBy: [] }
            entry.blockedBy.push(blocking)
            blocked.set(object.id, entry)
        }
        return [...blocked.values()]
    })

/** Fails with ReferencedByHost when an immediate, non-cascading host foreign key points at a selected Object. */
const requireNoHostReference = (ids: readonly string[]) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const keys = yield* sql<{ table: string; relation: string; column: string }>`select
                c.conrelid::regclass::text as table,
                format('%I.%I', n.nspname, r.relname) as relation,
                format('%I', a.attname) as column
            from pg_constraint c
            join pg_class r on r.oid = c.conrelid
            join pg_namespace n on n.oid = r.relnamespace
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = 'umwelt_object'::regclass and cardinality(c.conkey) = 1
            and c.confdeltype in ('a', 'r') and not c.condeferred`
        yield* Effect.forEach(keys, (key) =>
            Effect.gen(function* () {
                const column = sql.literal(key.column)
                const found = yield* sql`select 1 from ${sql.literal(key.relation)}
                    where ${within(sql, column, ids)} limit 1`
                if (found.length > 0) return yield* new ReferencedByHost({ table: key.table })
            })
        )
    })

const deleteSelected = (model: ResolvedModel, condition: Statement.Fragment) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const matched = yield* sql<Reference>`select o.type, o.id from umwelt_object o where ${condition} for update`
        if (matched.length === 0) return nothing()
        const ids = matched.map(({ id }) => id)
        const blocked = yield* blockedOf(model, ids)
        if (blocked.length > 0) return { matched, deleted: [], blocked } satisfies Deleted
        yield* requireNoHostReference(ids)
        yield* sql`delete from umwelt_object where ${within(sql, sql`id`, ids)}`
        return { matched, deleted: matched, blocked: [] } satisfies Deleted
    })

/** Input is the operation's input with `type` set, unvalidated; result is the documented shape. */
export const remove = (
    model: ResolvedModel,
    input: unknown
): Effect.Effect<Deleted, DeleteError | SqlError.SqlError, SqlClient.SqlClient> =>
    guarded(
        model,
        Effect.gen(function* () {
            const fields = yield* exact(input, ["type", "where", "ids", "allowAll"], "Delete")
            const types = yield* typesOf(model, fields["type"])
            const condition = yield* selectionOf(model, types, fields)
            return condition === undefined ? nothing() : yield* deleteSelected(model, condition)
        })
    )
