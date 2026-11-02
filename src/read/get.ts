/** Get: Objects by Object ID, with include. See CONTEXT/client/get.md. */
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { ReadError } from "../api.ts"
import type { ResolvedModel } from "../resolve.ts"
import { exact, invalid, typeOf } from "../input.ts"
import { requireReadable } from "../storage/gate.ts"
import { all, includeOf } from "./plan.ts"
import { select } from "./select.ts"

const keys = ["type", "id", "ids", "include"]

const idsOf = (id: unknown, ids: unknown) => {
    if (typeof id === "string" && ids === undefined) return Effect.succeed([id])
    if (id === undefined && Array.isArray(ids) && ids.length > 0 && ids.every((item) => typeof item === "string"))
        return Effect.succeed(ids)
    return invalid("Get takes id or a non-empty ids list, of Object IDs")
}

/** Input is the operation's input with `type` set, unvalidated; result is the documented shape. */
export const get = (
    model: ResolvedModel,
    input: unknown
): Effect.Effect<unknown, ReadError | SqlError.SqlError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
        yield* requireReadable(model)
        const fields = yield* exact(input, keys, "Get")
        const type = yield* typeOf(model, fields["type"])
        const ids = yield* idsOf(fields["id"], fields["ids"])
        const node = { type, edges: yield* includeOf(model, type, fields["include"]) }
        const found = new Map((yield* select(model, node, all, { ids })).map((object) => [object.id, object]))
        const objects = ids.map((id) => found.get(id) ?? null)
        return fields["id"] === undefined ? objects : (objects[0] ?? null)
    })
