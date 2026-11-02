/** Deploy: applies pending Migrations in one transaction, after `ensureLayout`. See CONTEXT/client/deploy.md. */
import { Effect } from "effect"
import { Blocked } from "../errors.ts"
import { migrationHash } from "../migration.ts"
import type { ResolvedModel } from "../resolve.ts"
import { lockModel } from "../storage/gate.ts"
import { ensureLayout, umweltSql } from "../storage/tables.ts"
import { requireTargets } from "../write/targets.ts"
import { applyMigration } from "./apply.ts"
import { changeOf, stored } from "./check.ts"

const applyPending = (model: ResolvedModel) =>
    Effect.gen(function* () {
        yield* ensureLayout
        const state = yield* stored
        const { blocking } = changeOf(model, state)
        if (blocking.length > 0) return yield* new Blocked({ reasons: blocking })
        const pending = model.migrations.slice(state.ledger.length)
        if (pending.length === 0) return { applied: [] }
        yield* Effect.forEach(pending, applyMigration, { discard: true })
        yield* requireTargets(
            [...model.types.values()].map((type) => ({ type })),
            { lock: false }
        )
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
 * Holds the Model lock exclusively from before reading the Ledger to the end, so Object operations in flight finish first
 * and later ones see the new Ledger. Runs Check inside the transaction; any failure rolls back everything, the first layout included.
 */
export const deploy = (model: ResolvedModel) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        return yield* sql.withTransaction(Effect.andThen(lockModel, applyPending(model)))
    })
