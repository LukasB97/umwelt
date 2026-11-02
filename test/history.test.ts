import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { history } from "../src/write/history.ts"
import { aheadOf, chainOf } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"
import { Play, Playlist, Track } from "./model.ts"

const Log = Umwelt.type("Log", { at: Schema.Date }, { history: true })
const types = [Track, Play, Playlist, Log] as const
const chain = chainOf(types)
const umwelt = Umwelt.make(types, { migrations: chain })
const model = resolveModel(types, chain)
const first = new Date("2026-10-29T08:00:00.000Z")
const second = new Date("2026-10-29T12:00:00.000Z")

const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`truncate umwelt_object cascade`
    yield* umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive", seconds: 420 } })
})

const fails = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, expected: object) =>
    Effect.map(Effect.flip(effect), (error) => expect(error).toMatchObject(expected))

const invalid = (input: unknown) => fails(history(model, input), { _tag: "ValidationFailed" })

describe("history", () => {
    layer(TestDatabase("history"))((it) => {
        it.effect("deploys the Model", () => umwelt.deploy())

        it.effect("previous full states in change order, by Identity or Object ID", () =>
            Effect.gen(function* () {
                yield* reset
                const { id } = yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [], tags: [] } })
                expect(yield* umwelt.Playlist.history({ object: id })).toEqual([])
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tags: ["x"] } })
                const byIdentity = yield* umwelt.Playlist.history({ object: { name: "road-trip" } })
                expect(byIdentity.map((entry) => entry.payload)).toEqual([
                    { name: "road-trip", tracks: [], tags: [] },
                    { name: "road-trip", tracks: [{ slug: "night-drive" }], tags: [] }
                ])
                expect(byIdentity.every((entry) => entry.replacedAt instanceof Date)).toBe(true)
                expect(yield* umwelt.history({ type: Playlist, object: id })).toEqual(byIdentity)
            })
        )

        it.effect("payloads come back in the Type schema", () =>
            Effect.gen(function* () {
                yield* reset
                const { id } = yield* umwelt.Log.write({ data: { at: first } })
                yield* umwelt.Log.write({ id, data: { at: second } })
                const entries = yield* umwelt.Log.history({ object: id })
                expect(entries.map((entry) => entry.payload)).toEqual([{ at: first }])
            })
        )

        it.effect("unknown Objects give an empty list", () =>
            Effect.gen(function* () {
                yield* reset
                const { id } = yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [], tags: [] } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tags: ["x"] } })
                const track = yield* umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive Remix" } })
                expect(yield* umwelt.Playlist.history({ object: { name: "chill" } })).toEqual([])
                const other = yield* Schema.decodeEffect(Playlist.ObjectId)(track.id)
                const malformed = yield* Schema.decodeEffect(Playlist.ObjectId)("not an id")
                expect(yield* umwelt.Playlist.history({ object: other })).toEqual([])
                expect(yield* umwelt.Playlist.history({ object: malformed })).toEqual([])
                yield* umwelt.Playlist.delete({ ids: [id] })
                expect(yield* umwelt.Playlist.history({ object: id })).toEqual([])
            })
        )

        it.effect("rejects keys the input types do not allow", () =>
            Effect.gen(function* () {
                yield* reset
                yield* invalid({ type: Track, object: { slug: "night-drive" } })
                yield* invalid({ type: Playlist, object: { name: "road-trip", extra: 1 } })
                yield* invalid({ type: Playlist, object: { slug: "road-trip" } })
                yield* invalid({ type: Playlist, object: 1 })
                yield* invalid({ type: Playlist, object: { name: "road-trip" }, extra: 1 })
                yield* invalid({ type: Playlist })
                yield* invalid({ type: Log, object: { at: first } })
                yield* invalid({ object: { name: "road-trip" } })
            })
        )

        it.effect("fails with ModelMismatch unless Ledger's head is the chain's head", () =>
            Effect.gen(function* () {
                const ahead = Umwelt.make(types, { migrations: aheadOf(chain) })
                yield* fails(ahead.Playlist.history({ object: { name: "road-trip" } }), {
                    _tag: "ModelMismatch",
                    code: "ahead"
                })
            })
        )
    })
})
