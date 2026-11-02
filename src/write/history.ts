/** History: previous full states of one Object. See CONTEXT/client/history.md. */
import { Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { ReadError } from "../api.ts"
import type { ResolvedModel, ResolvedType } from "../resolve.ts"
import { exact, identityOf, invalid, typeOf } from "../input.ts"
import { gatedRead, requireReadable } from "../storage/gate.ts"
import { umweltSql } from "../storage/tables.ts"

const historyType = (model: ResolvedModel, value: unknown) =>
    Effect.gen(function* () {
        const type = yield* typeOf(model, value)
        return type.history ? type : yield* invalid(`${type.name} keeps no history`)
    })

/** The Object as SQL condition on `o`: by Object ID, or by Identity for Types with unique key. */
const objectOf = (type: ResolvedType, object: unknown) =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        if (typeof object === "string") return sql`o.id = ${object}`
        if (type.identity === undefined) return yield* invalid(`${type.name} Objects are named by Object ID`)
        return sql`o.identity = ${yield* identityOf(type, object)}::jsonb`
    })

/**
 * Input is the operation's input with `type` set, unvalidated; result is the documented shape.
 * Read behind the Model gate in one statement, one row per entry; stored content is decoded without schema checks, see Get.
 */
export const history = (
    model: ResolvedModel,
    input: unknown
): Effect.Effect<unknown, ReadError | SqlError.SqlError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
        yield* requireReadable(model)
        const sql = yield* umweltSql
        const { type: value, object } = yield* exact(input, ["type", "object"], "History")
        const type = yield* historyType(model, value)
        const condition = yield* objectOf(type, object)
        const entries = yield* gatedRead(
            model,
            sql`select jsonb_build_object('payload', h.payload, 'replacedAt', h.replaced) as o, h.position as n
                from umwelt_history h join umwelt_object o on o.id = h.object
                where o.type = ${type.name} and ${condition}`
        )
        const Entries = Schema.Array(Schema.Struct({ payload: type.json, replacedAt: Schema.DateFromString }))
        return yield* Effect.orDie(Schema.decodeUnknownEffect(Entries)(entries, { disableChecks: true }))
    })
