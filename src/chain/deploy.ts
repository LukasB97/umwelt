/**
 * Deploy: one transaction of layout, Check, Migrations, missing unique constraints, and Ledger; after its commit, the drop of superseded unique constraints, when any. Locks
 * as `storage/gate.ts` orders them. See CONTEXT/client/deploy.md.
 */
import { Effect } from "effect"
import { Blocked } from "../errors.ts"
import { migrationHash } from "../migration.ts"
import type { ResolvedModel } from "../resolve.ts"
import { atHead, laidOut, lockLayout, lockObjects } from "../storage/gate.ts"
import { createObjects, ensureLayout, umweltSql } from "../storage/tables.ts"
import { createUnique, dropUnique, superseded } from "../storage/unique.ts"
import { requireTargets } from "../write/targets.ts"
import { applyMigration } from "./apply.ts"
import { changeOf, stored } from "./check.ts"

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(umweltSql, (sql) => sql.withTransaction(effect))

/** Inside a transaction block, a transaction-local setting outlives the statement that set it; outside, it does not. */
const insideTransaction = Effect.gen(function* () {
    const sql = yield* umweltSql
    yield* sql`select set_config('umwelt.open', 'yes', true)`
    const [row] = yield* sql<{ open: boolean }>`select current_setting('umwelt.open', true) = 'yes' as open`
    return row?.open === true
})

const applyPending = (model: ResolvedModel) =>
    Effect.gen(function* () {
        yield* ensureLayout
        const state = yield* stored
        const { blocking } = changeOf(model, state)
        if (blocking.length > 0) return yield* new Blocked({ reasons: blocking })
        const pending = model.migrations.slice(state.ledger.length)
        if (pending.length === 0) return yield* Effect.as(createUnique(model), { applied: [] })
        yield* Effect.forEach(pending, (migration) => applyMigration(model, migration), { discard: true })
        yield* requireTargets(
            [...model.types.values()].map((type) => ({ type })),
            { lock: false }
        )
        yield* createUnique(model)
        const sql = yield* umweltSql
        yield* Effect.forEach(
            pending,
            (migration, index) => sql`insert into umwelt_ledger (position, id, hash)
                values (${state.ledger.length + index + 1}, ${migration.id}, ${migrationHash(migration)})`,
            { discard: true }
        )
        return { applied: pending.map(({ id }) => id) }
    })

/**
 * SHARE ROW EXCLUSIVE keeps writes and other Deploys out and lets reads run: writes in flight finish first, later ones
 * see the new Ledger. Any failure rolls back everything, the first layout included.
 */
const deployment = (model: ResolvedModel) =>
    Effect.gen(function* () {
        if (!(yield* laidOut)) yield* Effect.andThen(lockLayout, createObjects)
        yield* lockObjects("share row exclusive")
        return yield* applyPending(model)
    })

/**
 * Drops unique constraints the Model no longer declares, after Deploy's commit. Decided under ACCESS EXCLUSIVE from the
 * committed Ledger, so a Deploy of an older Model drops nothing a newer one declares. Inside a host transaction the lock
 * would last to the host's commit: the next Deploy drops them, as it does after a failed drop.
 */
const retireUnique = (model: ResolvedModel) =>
    Effect.gen(function* () {
        if ((yield* superseded(model)).length === 0 || (yield* insideTransaction)) return
        yield* transaction(
            Effect.gen(function* () {
                yield* lockObjects("access exclusive")
                if (yield* atHead(model)) yield* dropUnique(yield* superseded(model))
            })
        )
    }).pipe(Effect.ignore)

export const deploy = (model: ResolvedModel) =>
    Effect.gen(function* () {
        const deployed = yield* transaction(deployment(model))
        yield* retireUnique(model)
        return deployed
    })
