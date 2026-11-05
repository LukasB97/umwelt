/**
 * Model gate: Object operations run only while Ledger's head is the chain's head and Model in code is valid and equals
 * the folded chain. Every transaction changing `umwelt_object` takes its table lock first, so none waits in a cycle:
 * writes ROW EXCLUSIVE; Deploy SHARE ROW EXCLUSIVE, which keeps writes and other Deploys out and lets reads run; its
 * drop of unique indexes ACCESS EXCLUSIVE, in a transaction of its own. Before the tables
 * exist, an advisory lock stands in for the table lock of the Deploy creating them. Reads take no lock of their own:
 * each reads Ledger's head in the statement that reads its data, so both come from one snapshot.
 */
import { Effect } from "effect"
import type { Statement } from "effect/sql"
import { ModelMismatch } from "../errors.ts"
import type { ResolvedModel } from "../resolve.ts"
import { umweltSql } from "./tables.ts"

export type Applied = { readonly id: string; readonly hash: string }

/** Advisory lock key standing in for `umwelt_object` before it exists, "layout" in ASCII. */
const layoutLock = 0x6c_61_79_6f_75_74

/** Umwelt's tables exist: the first Deploy made them. */
export const laidOut = Effect.gen(function* () {
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

const isHead = (model: ResolvedModel, head: Head | undefined) =>
    head?.id === model.head?.id && head?.hash === model.head?.hash

const requireHead = (model: ResolvedModel, head: Head | undefined) =>
    model.current && model.valid && isHead(model, head)
        ? Effect.void
        : Effect.fail(new ModelMismatch({ database: head?.id ?? null, code: model.head?.id ?? null }))

/** Whether Ledger's head is Model's; under a lock keeping Deploy out, the committed Ledger decides. */
export const atHead = (model: ResolvedModel) => Effect.map(ledgerHead, (head) => isHead(model, head))

type TableLock = "row exclusive" | "share row exclusive" | "access exclusive"

/** The transaction's first lock on `umwelt_object`, held to its end. */
export const lockObjects = (mode: TableLock) =>
    Effect.flatMap(umweltSql, (sql) => sql`lock table umwelt_object in ${sql.literal(mode)} mode`)

/** Before the tables exist, Deploy holds this lock while it creates `umwelt_object`, so a concurrent first Deploy waits. */
export const lockLayout = Effect.flatMap(umweltSql, (sql) => sql`select pg_advisory_xact_lock(${layoutLock}::bigint)`)

/** The write's table lock, held to the end of the transaction; then fails with ModelMismatch unless Model and Ledger agree. */
const requireModel = (model: ResolvedModel) =>
    Effect.gen(function* () {
        if (!(yield* laidOut)) return yield* requireHead(model, undefined)
        yield* lockObjects("row exclusive")
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
 * No lock and no transaction, so reads wait for no Deploy but its ACCESS EXCLUSIVE steps.
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
