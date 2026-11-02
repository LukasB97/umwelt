/**
 * Model gate: Object operations run only while Ledger's head is the chain's head and Model in code is valid and equals
 * the folded chain. Writes and Deploy stay apart through a transaction-scoped advisory lock: writes hold it shared,
 * Deploy exclusively. Reads take no lock: each reads Ledger's head in the statement that reads its data, so both come
 * from one snapshot.
 */
import { Effect } from "effect"
import type { Statement } from "effect/sql"
import { ModelMismatch } from "../errors.ts"
import type { ResolvedModel } from "../resolve.ts"
import { umweltSql } from "./tables.ts"

export type Applied = { readonly id: string; readonly hash: string }

/** Advisory lock key of the Model, "umwelt" in ASCII. */
const modelLock = 0x75_6d_77_65_6c_74

/** Umwelt's tables exist: the first Deploy made them. */
const laidOut = Effect.gen(function* () {
    const sql = yield* umweltSql
    const [table] = yield* sql<{ present: boolean }>`select to_regclass('umwelt_ledger') is not null as present`
    return table?.present === true
})

/** Applied Migrations in order; empty before the first Deploy, also while Umwelt's tables do not exist. */
export const appliedMigrations = Effect.gen(function* () {
    if (!(yield* laidOut)) return []
    const sql = yield* umweltSql
    return yield* sql<Applied>`select id, hash from umwelt_ledger order by position`
})

/** Ledger head `null` when Ledger is empty. */
type Head = { readonly id: string | null; readonly hash: string | null }

/** Ledger's head row alone; `undefined` while Umwelt's tables do not exist. */
const ledgerHead = Effect.gen(function* () {
    if (!(yield* laidOut)) return undefined
    const sql = yield* umweltSql
    const [head] = yield* sql<Head>`select id, hash from umwelt_ledger order by position desc limit 1`
    return head
})

const requireHead = (model: ResolvedModel, head: Head | undefined) =>
    model.current && model.valid && head?.id === model.head?.id && head?.hash === model.head?.hash
        ? Effect.void
        : Effect.fail(new ModelMismatch({ database: head?.id ?? null, code: model.head?.id ?? null }))

/** Deploy's side: writes of other transactions wait until this transaction ends, and it for theirs. */
export const lockModel = Effect.flatMap(umweltSql, (sql) => sql`select pg_advisory_xact_lock(${modelLock}::bigint)`)

/** Takes the Model lock shared for the rest of the transaction, then fails with ModelMismatch unless Model and Ledger agree. */
export const requireModel = (model: ResolvedModel) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        yield* sql`select pg_advisory_xact_lock_shared(${modelLock}::bigint)`
        return yield* requireHead(model, yield* ledgerHead)
    })

/** A write in one transaction behind the gate: no Deploy commits between the check and the write's end. */
export const guarded = <A, E, R>(model: ResolvedModel, operation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        return yield* sql.withTransaction(Effect.andThen(requireModel(model), operation))
    })

/** Reads are planned against Model in code: unless it is valid and equals the folded chain, they fail before planning. */
export const requireReadable = (model: ResolvedModel) =>
    model.current && model.valid ? Effect.void : Effect.flatMap(ledgerHead, (head) => requireHead(model, head))

/**
 * A read: `rows`, a query with columns `o`, one value per row, and `n`, its rank, read in the statement that reads
 * Ledger's head, and only while that head is the chain's; the values in rank order. Head row first, then one row per
 * value; `exists` is evaluated once, so `rows` runs only behind a matching head. One statement sees one snapshot,
 * also inside a host transaction at READ COMMITTED: a Deploy committing meanwhile is seen completely or not at all.
 * No lock and no transaction, so reads never wait for Deploy.
 */
export const gatedRead = (model: ResolvedModel, rows: Statement.Fragment) =>
    Effect.gen(function* () {
        if (!(yield* laidOut)) return yield* Effect.as(requireHead(model, undefined), [])
        const sql = yield* umweltSql
        const [head, ...read] = yield* sql<Head & { readonly o: unknown }>`
            with head as (select id, hash from umwelt_ledger order by position desc limit 1)
            select head.id, head.hash, null::jsonb as o, null::bigint as n from (select) as one left join head on true
            union all
            select null, null, page.o, page.n from (${rows}) as page
            where exists (select from head where id = ${model.head?.id ?? null} and hash = ${model.head?.hash ?? null})
            order by n nulls first`
        yield* requireHead(model, head)
        return read.map(({ o }) => o)
    })
