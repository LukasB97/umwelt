/** Query: where, orderBy, pagination, include. See CONTEXT/client/query.md. */
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { ReadError } from "../api.ts"
import type { ResolvedModel } from "../resolve.ts"
import { exact, typeOf } from "../input.ts"
import { requireReadable } from "../storage/gate.ts"
import { includeOf, pageOf } from "./plan.ts"
import { select } from "./select.ts"

const keys = ["type", "where", "orderBy", "take", "skip", "cursor", "include"]

/**
 * Input is the operation's input with `type` set, unvalidated.
 * `pageInfo.hasMore` tells whether Objects follow the page; `cursor` continues after the Object ID it names.
 */
export const query = (
    model: ResolvedModel,
    input: unknown
): Effect.Effect<unknown, ReadError | SqlError.SqlError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
        yield* requireReadable(model)
        const fields = yield* exact(input, keys, "Query")
        const type = yield* typeOf(model, fields["type"])
        const node = { type, edges: yield* includeOf(model, type, fields["include"]) }
        const page = yield* pageOf(type, fields)
        const limit = page.take === undefined ? {} : { limit: page.take + 1 }
        const objects = yield* select(model, node, page, limit)
        return {
            objects: objects.slice(0, page.take),
            pageInfo: { hasMore: objects.length > (page.take ?? Infinity) }
        }
    })
