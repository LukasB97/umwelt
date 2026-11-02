/** Applies one checked Write entry to stored state: conditions, overlay, immutability, history. */
import { Effect, Schema } from "effect"
import type { SqlClient, SqlError, Statement } from "effect/sql"
import { canonicalJson } from "../canonical.ts"
import { ConditionRejected, type ValidationFailed } from "../errors.ts"
import { umweltSql } from "../storage/tables.ts"
import type { Entry, Match } from "./entry.ts"
import { encode, isRecord, type Input } from "../input.ts"

type Stored = { readonly id: string; readonly payload: Input }
export type Applied = { readonly id: string; readonly outcome: "created" | "changed" | "unchanged" }
type ApplyError = ConditionRejected | ValidationFailed | SqlError.SqlError

const reject = (reason: ConditionRejected["reason"]) => Effect.fail(new ConditionRejected({ reason }))

/** The addressed Object, locked for the rest of the operation; `no key update`, so Writes pointing at it are not held up. */
const locate = (sql: Statement.Constructor, entry: Entry) =>
    Effect.gen(function* () {
        const { address, type } = entry
        if (address === undefined) return undefined
        const rows = yield* "id" in address
            ? sql<Stored>`select id, payload from umwelt_object where type = ${type.name} and id = ${address.id} for no key update`
            : sql<Stored>`select id, payload from umwelt_object
                where type = ${type.name} and identity = ${address.identity}::jsonb for no key update`
        return rows[0]
    })

const matches = ({ fields, missing }: Match, payload: Input) =>
    [...missing].every((key) => !(key in payload)) &&
    Object.entries(fields).every(
        ([key, expected]) => key in payload && canonicalJson(payload[key]) === canonicalJson(expected)
    )

const guard = (entry: Entry, current: Stored | undefined) => {
    if (current !== undefined && entry.condition === "mustNotExist") return reject("mustNotExist")
    if (current === undefined && entry.condition === "mustExist") return reject("mustExist")
    if (current === undefined && entry.address !== undefined && "id" in entry.address) return reject("unknownId")
    if (entry.match !== undefined && (current === undefined || !matches(entry.match, current.payload)))
        return reject("mustMatch")
    return Effect.void
}

/** Top-level overlay: a given field sets its value, a removed field goes, every other field keeps its current value. */
const overlay = (base: Input, { data, removed }: Entry) =>
    Object.fromEntries(Object.entries({ ...base, ...data }).filter(([key]) => !removed.has(key)))

/** Resulting state as stored JSON; current content is decoded without schema checks, the result with them. */
const stateOf = (entry: Entry, current: Stored | undefined) =>
    Effect.gen(function* () {
        const { type } = entry
        if (entry.state !== undefined) return entry.state
        const base =
            current === undefined
                ? {}
                : yield* Effect.orDie(Schema.decodeEffect(type.json)(current.payload, { disableChecks: true }))
        return yield* encode(type.json, overlay(isRecord(base) ? base : {}, entry), type.name)
    })

/**
 * A create that meets a concurrent create of the same Identity waits for it; once that commits, nothing is inserted
 * and the entry applies again, now to the existing Object, so its condition decides. Identity is the only unique rule an
 * insert can meet, so the conflict names no index. Inserts get `created` and `changed` from the database clock.
 */
export const apply = (entry: Entry): Effect.Effect<Applied, ApplyError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
        const sql = yield* umweltSql
        const { type, address } = entry
        const current = yield* locate(sql, entry)
        yield* guard(entry, current)
        const state = yield* stateOf(entry, current)
        const json = JSON.stringify(state)
        if (current === undefined) {
            const identity = address !== undefined && "identity" in address ? address.identity : null
            const [created] = yield* sql<{ id: string }>`insert into umwelt_object (type, identity, payload)
                values (${type.name}, ${identity}::jsonb, ${json}::jsonb)
                on conflict do nothing returning id`
            if (created === undefined) return yield* apply(entry)
            return { id: created.id, outcome: "created" } satisfies Applied
        }
        if (canonicalJson(current.payload) === canonicalJson(state))
            return { id: current.id, outcome: "unchanged" } satisfies Applied
        if (type.immutable) return yield* reject("immutable")
        if (type.history)
            yield* sql`insert into umwelt_history (object, payload) select id, payload from umwelt_object where id = ${current.id}`
        yield* sql`update umwelt_object set payload = ${json}::jsonb, changed = now() where id = ${current.id}`
        return { id: current.id, outcome: "changed" } satisfies Applied
    })
