/**
 * Unique constraints in the database: one partial unique index per constraint on `umwelt_object`, named by its
 * definition. Write and Deploy turn a violation of one the Model declares into UniqueViolation; Deploy creates the
 * declared indexes in its transaction and drops superseded ones in a transaction after it.
 */
import { Effect } from "effect"
import type { SqlError } from "effect/sql"
import { UniqueViolation } from "../errors.ts"
import type { ResolvedModel } from "../resolve.ts"
import type { UniqueIndex } from "../unique.ts"
import { umweltSql } from "./tables.ts"

const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

/** Index a unique violation names: Effect's Postgres client classifies it, other executors keep Postgres' fields in the cause. */
const violatedIndex = ({ reason }: SqlError.SqlError) => {
    if (reason._tag === "UniqueViolation") return reason.constraint
    const constraint = field(reason.cause, "constraint")
    return field(reason.cause, "code") === "23505" && typeof constraint === "string" ? constraint : undefined
}

/** UniqueViolation when the error violates one of the indexes, else the error as it is: a superseded index too. */
const violation = (type: string, indexes: readonly UniqueIndex[], error: SqlError.SqlError) => {
    const name = violatedIndex(error)
    const index = indexes.find((candidate) => candidate.name === name)
    return index === undefined ? error : new UniqueViolation({ type, fields: index.fields })
}

/** A statement writing rows of `type`: violating one of its unique constraints fails with UniqueViolation. */
export const enforcing = <A, R>(
    type: string,
    indexes: readonly UniqueIndex[],
    statement: Effect.Effect<A, SqlError.SqlError, R>
) => Effect.mapError(statement, (error) => violation(type, indexes, error))

/** Umwelt's unique indexes in the database, by name, with the name to drop them by. */
const existing = Effect.gen(function* () {
    const sql = yield* umweltSql
    const rows = yield* sql<{ name: string; qualified: string }>`select c.relname as name,
            i.indexrelid::regclass::text as qualified
        from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'umwelt_object'::regclass and starts_with(c.relname, 'umwelt_unique_')`
    return new Map(rows.map(({ name, qualified }) => [name, qualified]))
})

/** Every declared index, with its Type. */
const declared = (model: ResolvedModel) =>
    [...model.types.values()].flatMap((type) => type.unique.map((index) => ({ type, index })))

/** Creates every declared index missing; stored content holding values twice fails with UniqueViolation. */
export const createUnique = (model: ResolvedModel) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const present = yield* existing
        const missing = declared(model).filter(({ index }) => !present.has(index.name))
        yield* Effect.forEach(
            missing,
            ({ type, index }) =>
                Effect.mapError(sql`${sql.literal(index.definition)}`, (error) => violation(type.name, [index], error)),
            { discard: true }
        )
    })

/** Names to drop the indexes in the database by that the Model does not declare. */
export const superseded = (model: ResolvedModel) =>
    Effect.map(existing, (present) => {
        const kept = new Set(declared(model).map(({ index }) => index.name))
        return [...present].filter(([name]) => !kept.has(name)).map(([, qualified]) => qualified)
    })

/** Drops the indexes, inside the transaction: needs ACCESS EXCLUSIVE on `umwelt_object`. */
export const dropUnique = (qualified: readonly string[]) =>
    Effect.flatMap(umweltSql, (sql) =>
        Effect.forEach(qualified, (name) => sql`drop index ${sql.literal(name)}`, { discard: true })
    )
