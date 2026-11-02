/** Strict relation targets must exist: of written Objects once the whole Write list applied, of every Object after Deploy. */
import { Effect } from "effect"
import { MissingTarget } from "../errors.ts"
import type { ResolvedType } from "../resolve.ts"
import { umweltSql } from "../storage/tables.ts"
import { within } from "../where.ts"

/** Objects of `type`: those `ids` names, or all of them. */
export type Sources = { readonly type: ResolvedType; readonly ids?: readonly string[] }

/**
 * Fails with MissingTarget for the first strict reference of the sources naming no Object.
 * With `lock`, each target found is locked `for key share` until the transaction ends, so a concurrent Delete waits and
 * then sees the source; Deploy needs none, its exclusive Model lock keeps writes and Deletes out.
 */
export const requireTargets = (sources: readonly Sources[], { lock }: { readonly lock: boolean }) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const checks = sources.flatMap(({ type, ids }) =>
            type.relations.filter(({ mode }) => mode === "strict").map((location) => ({ type, ids, location }))
        )
        yield* Effect.forEach(
            checks,
            ({ type, ids, location }) =>
                Effect.gen(function* () {
                    const narrowed = ids === undefined ? sql.literal("") : sql`and ${within(sql, sql`source.id`, ids)}`
                    const [missing] = yield* sql<{ identity: unknown }>`select reference as identity
                        from umwelt_object source, jsonb_path_query(source.payload, ${location.path}::jsonpath) reference
                        where source.type = ${type.name} ${narrowed}
                        and not exists (select 1 from umwelt_object target
                            where target.type = ${location.target} and target.identity = reference
                            ${sql.literal(lock ? "for key share" : "")})
                        limit 1`
                    if (missing !== undefined)
                        return yield* new MissingTarget({ type: location.target, identity: missing.identity })
                }),
            { discard: true }
        )
    })
