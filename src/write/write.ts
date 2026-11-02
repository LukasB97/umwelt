/** Write: entries by Identity or Object ID, conditions, overlay, lists. See CONTEXT/client/write.md. */
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { WriteError } from "../api.ts"
import { DuplicateIdentity } from "../errors.ts"
import type { ResolvedModel } from "../resolve.ts"
import { guarded } from "../storage/gate.ts"
import { apply, type Applied } from "./apply.ts"
import { entryOf, type Entry } from "./entry.ts"
import { requireTargets } from "./targets.ts"

const hasDuplicateIdentity = (entries: readonly Entry[]) => {
    const identities = entries.flatMap(({ type, address }) =>
        address !== undefined && "identity" in address ? [JSON.stringify([type.name, address.identity])] : []
    )
    return new Set(identities).size !== identities.length
}

/** Entries in order, each seeing earlier ones; strict targets checked after the whole list. */
const writeAll = (model: ResolvedModel, input: readonly unknown[]) =>
    Effect.gen(function* () {
        const entries = yield* Effect.forEach(input, (entry) => entryOf(model, entry))
        if (hasDuplicateIdentity(entries)) return yield* new DuplicateIdentity()
        const applied = yield* Effect.forEach(entries, (entry) =>
            Effect.map(apply(entry), (result) => ({ ...result, type: entry.type }))
        )
        const written = applied.filter(({ outcome }) => outcome !== "unchanged")
        yield* requireTargets(
            [...new Set(written.map(({ type }) => type))].map((type) => ({
                type,
                ids: written.filter((object) => object.type === type).map(({ id }) => id)
            })),
            { lock: true }
        )
        return applied.map(({ id, outcome }): Applied => ({ id, outcome }))
    })

/** Input is the operation's input with `type` set, unvalidated; result is the documented shape. */
export const write = (
    model: ResolvedModel,
    input: unknown
): Effect.Effect<Applied | Applied[] | undefined, WriteError | SqlError.SqlError, SqlClient.SqlClient> =>
    guarded(
        model,
        Effect.gen(function* () {
            if (Array.isArray(input)) return yield* writeAll(model, input)
            const [result] = yield* writeAll(model, [input])
            return result
        })
    )
