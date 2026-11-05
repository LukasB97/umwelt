/** Chains built the way `umwelt create` builds them, and stored content written straight into Umwelt's tables. */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { nextMigration } from "../src/chain/create.ts"
import { canonicalJson } from "../src/canonical.ts"
import type { AnyType } from "../src/declaration.ts"
import { migrationHash, type Migration } from "../src/migration.ts"
import { resolveModel } from "../src/resolve.ts"

type Payload = Readonly<Record<string, unknown>>

const isPayload = (value: unknown): value is Payload => typeof value === "object" && value !== null

/** Appends what `umwelt create` writes for `types`, with `migrate` filled for the Types named in `migrate`. */
export const extend = (
    chain: readonly Migration[],
    types: readonly AnyType[],
    migrate: Readonly<Record<string, (old: Payload) => unknown>> = {}
): readonly Migration[] => {
    const next = nextMigration(
        resolveModel(types, chain),
        `v${chain.length}`,
        new Date(Date.UTC(2026, 9, 29, 8, chain.length))
    )
    if (next === undefined) throw new Error("Model and chain agree")
    const steps = Object.entries(next.types).map(([type, step]): [string, Migration["types"][string]] => {
        const fill = migrate[type]
        return [
            type,
            fill === undefined ? step : { ...step, migrate: (old: unknown) => fill(isPayload(old) ? old : {}) }
        ]
    })
    return [...chain, { ...next, types: Object.fromEntries(steps) }]
}

/** A chain whose Migrations each make the Model of one entry. */
export const chainOf = (...models: readonly (readonly AnyType[])[]) =>
    models.reduce<readonly Migration[]>((chain, types) => extend(chain, types), [])

/** The chain with one more Migration touching no Type: it folds to the same Model, its head is ahead of the Ledger. */
export const aheadOf = (chain: readonly Migration[]): readonly Migration[] => {
    const last = chain.at(-1)
    const parent = last === undefined ? null : { id: last.id, hash: migrationHash(last) }
    return [...chain, { id: "ahead", parent, types: {} }]
}

export const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`drop table if exists umwelt_history, umwelt_object, umwelt_ledger`
})

export const insertObject = (type: string, payload: Payload, identity?: Payload) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ id: string }>`insert into umwelt_object (type, identity, payload)
            values (${type}, ${identity === undefined ? null : canonicalJson(identity)}::jsonb, ${canonicalJson(payload)}::jsonb)
            returning id`
        return row?.id ?? ""
    })

export const insertHistory = (object: string, payload: Payload) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`insert into umwelt_history (object, payload) values (${object}, ${canonicalJson(payload)}::jsonb)`
    })

/** Current payloads of a Type, and every history payload of its Objects, oldest first. */
export const storedOf = (type: string) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const objects = yield* sql<{
            payload: unknown
        }>`select payload from umwelt_object where type = ${type} order by id`
        const history = yield* sql<{ payload: unknown }>`select h.payload from umwelt_history h
            join umwelt_object o on o.id = h.object where o.type = ${type} order by h.position`
        return { objects: objects.map(({ payload }) => payload), history: history.map(({ payload }) => payload) }
    })

export const ledgerOf = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string }>`select id from umwelt_ledger order by position`
    return rows.map(({ id }) => id)
})

export const tableExists = (name: string) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ present: boolean }>`select to_regclass(${name}) is not null as present`
        return row?.present === true
    })

/** Names of Umwelt's unique indexes in the database, sorted. */
export const uniqueIndexes = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ name: string }>`select indexname as name from pg_indexes
        where tablename = 'umwelt_object' and starts_with(indexname, 'umwelt_unique_') order by indexname`
    return rows.map(({ name }) => name)
})
