import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { remove } from "../src/write/delete.ts"
import { aheadOf, chainOf } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"
import { Play, Playlist, Track } from "./model.ts"

const Note = Umwelt.type("Note", { source: Schema.String })
const types = [Track, Play, Playlist, Note] as const
const chain = chainOf(types)
const umwelt = Umwelt.make(types, { migrations: chain })
const model = resolveModel(types, chain)
const at = new Date("2026-10-29T08:00:00.000Z")

const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`truncate umwelt_object cascade`
    const [nightDrive, firstLight] = yield* umwelt.Track.write([
        { data: { slug: "night-drive", title: "Night Drive", seconds: 420 } },
        { data: { slug: "first-light", title: "First Light", seconds: 380 } }
    ])
    const play = yield* umwelt.Play.write({ data: { source: "car", track: { slug: "night-drive" }, at } })
    if (nightDrive === undefined || firstLight === undefined) return yield* Effect.die(new Error("seed"))
    return { nightDrive: nightDrive.id, firstLight: firstLight.id, play: play.id }
})

const remaining = (type: string) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ id: string }>`select id from umwelt_object where type = ${type} order by id`
        return rows.map((row) => row.id)
    })

const sorted = (references: readonly { type: string; id: string }[]) =>
    references.toSorted((a, b) => `${a.type}${a.id}`.localeCompare(`${b.type}${b.id}`))

const fails = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, expected: object) =>
    Effect.map(Effect.flip(effect), (error) => expect(error).toMatchObject(expected))

const invalid = (input: unknown) => fails(remove(model, input), { _tag: "ValidationFailed" })

describe("delete", () => {
    layer(TestDatabase("delete"))((it) => {
        it.effect("deploys the Model", () => umwelt.deploy())

        it.effect("deletes by where; nothing when content no longer matches", () =>
            Effect.gen(function* () {
                const { nightDrive, firstLight } = yield* seed
                expect(yield* umwelt.Track.delete({ where: { slug: "night-drive", title: "Old" } })).toEqual({
                    matched: [],
                    deleted: [],
                    blocked: []
                })
                const result = yield* umwelt.Track.delete({ where: { seconds: { gt: 400 } } })
                const reference = { type: "Track", id: nightDrive }
                expect(result).toEqual({ matched: [reference], deleted: [reference], blocked: [] })
                expect(yield* remaining("Track")).toEqual([firstLight])
            })
        )

        it.effect("deletes by ids; unknown IDs match nothing", () =>
            Effect.gen(function* () {
                const { nightDrive, firstLight, play } = yield* seed
                yield* umwelt.Play.delete({ ids: [play] })
                const gone = yield* Schema.decodeEffect(Play.ObjectId)(play)
                const other = yield* Schema.decodeEffect(Play.ObjectId)(nightDrive)
                const malformed = yield* Schema.decodeEffect(Play.ObjectId)("not an id")
                expect(yield* umwelt.Play.delete({ ids: [gone, other, malformed] })).toEqual({
                    matched: [],
                    deleted: [],
                    blocked: []
                })
                const playAsTrack = yield* Schema.decodeEffect(Track.ObjectId)(play)
                const result = yield* umwelt.Track.delete({ ids: [nightDrive, playAsTrack] })
                expect(result.deleted).toEqual([{ type: "Track", id: nightDrive }])
                expect(yield* remaining("Track")).toEqual([firstLight])
            })
        )

        it.effect("allowAll deletes every Object of the selected Types; where false selects nothing", () =>
            Effect.gen(function* () {
                const { nightDrive, firstLight, play } = yield* seed
                expect(yield* umwelt.Track.delete({ where: false })).toEqual({ matched: [], deleted: [], blocked: [] })
                const result = yield* umwelt.delete({ type: [Track, Play], allowAll: true, where: true })
                const all = [
                    { type: "Play", id: play },
                    { type: "Track", id: nightDrive },
                    { type: "Track", id: firstLight }
                ]
                expect(sorted(result.matched)).toEqual(sorted(all))
                expect(sorted(result.deleted)).toEqual(sorted(all))
                expect([...(yield* remaining("Track")), ...(yield* remaining("Play"))]).toEqual([])
            })
        )

        it.effect("where applies to every selected Type", () =>
            Effect.gen(function* () {
                const { play } = yield* seed
                const note = yield* umwelt.Note.write({ data: { source: "car" } })
                yield* umwelt.Note.write({ data: { source: "mobile" } })
                yield* invalid({ type: [Track, Play], where: { source: "car" } })
                const result = yield* umwelt.delete({ type: [Play, Note], where: { source: "car" } })
                expect(sorted(result.deleted)).toEqual(
                    sorted([
                        { type: "Play", id: play },
                        { type: "Note", id: note.id }
                    ])
                )
            })
        )

        it.effect("strict relations from outside the selection block the whole delete", () =>
            Effect.gen(function* () {
                const { nightDrive, firstLight } = yield* seed
                const playlist = yield* umwelt.Playlist.write({
                    data: {
                        name: "road-trip",
                        tracks: [{ slug: "night-drive" }],
                        tags: [],
                        entries: [{ track: { slug: "night-drive" }, rating: 5 }]
                    }
                })
                const result = yield* umwelt.Track.delete({ allowAll: true })
                expect(sorted(result.matched)).toEqual(
                    sorted([
                        { type: "Track", id: nightDrive },
                        { type: "Track", id: firstLight }
                    ])
                )
                expect(result.deleted).toEqual([])
                expect(result.blocked).toHaveLength(1)
                expect(result.blocked[0]?.object).toEqual({ type: "Track", id: nightDrive })
                expect(result.blocked[0]?.blockedBy.toSorted((a, b) => a.field.localeCompare(b.field))).toEqual([
                    { source: { type: "Playlist", id: playlist.id }, field: "entries[].track" },
                    { source: { type: "Playlist", id: playlist.id }, field: "tracks" }
                ])
                expect(yield* remaining("Track")).toHaveLength(2)
            })
        )

        it.effect("Objects referencing each other go together; sparse references stay untouched", () =>
            Effect.gen(function* () {
                const { nightDrive, play } = yield* seed
                const playlist = yield* umwelt.Playlist.write({
                    data: { name: "road-trip", tracks: [{ slug: "night-drive" }], tags: [] }
                })
                const result = yield* umwelt.delete({ type: [Track, Playlist], ids: [nightDrive, playlist.id] })
                expect(result.blocked).toEqual([])
                expect(result.deleted).toHaveLength(2)
                const sql = yield* SqlClient.SqlClient
                const [left] = yield* sql<{ payload: unknown }>`select payload from umwelt_object where id = ${play}`
                expect(left?.payload).toEqual({ source: "car", track: { slug: "night-drive" }, at: at.toISOString() })
            })
        )

        it.effect("deleting Objects removes their history", () =>
            Effect.gen(function* () {
                yield* seed
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [], tags: [] } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [], tags: ["x"] } })
                yield* umwelt.Playlist.delete({ where: { name: "road-trip" } })
                const sql = yield* SqlClient.SqlClient
                const [history] = yield* sql<{ count: number }>`select count(*)::int as count from umwelt_history`
                expect(history?.count).toBe(0)
            })
        )

        it.effect("immediate host foreign keys fail with ReferencedByHost and leave nothing behind", () =>
            Effect.gen(function* () {
                const { nightDrive, firstLight } = yield* seed
                const sql = yield* SqlClient.SqlClient
                yield* sql`create table favorite (track_id text not null references umwelt_object (id))`
                yield* sql`create table seen (track_id text references umwelt_object (id) on delete cascade)`
                yield* sql`insert into favorite values (${nightDrive})`
                yield* sql`insert into seen values (${firstLight})`
                yield* sql.withTransaction(
                    Effect.gen(function* () {
                        yield* fails(umwelt.Track.delete({ allowAll: true }), {
                            _tag: "ReferencedByHost",
                            table: "favorite"
                        })
                        yield* sql`insert into favorite values (${nightDrive})`
                    })
                )
                expect(yield* remaining("Track")).toHaveLength(2)
                yield* umwelt.Track.delete({ ids: [firstLight] })
                const [seen] = yield* sql<{ count: number }>`select count(*)::int as count from seen`
                expect(seen?.count).toBe(0)
                yield* sql`drop table favorite, seen`
            })
        )

        it.effect("deferred host foreign keys are not seen by Delete and fail at the host's commit", () =>
            Effect.gen(function* () {
                const { nightDrive } = yield* seed
                const sql = yield* SqlClient.SqlClient
                yield* sql`create table later (track_id text references umwelt_object (id) deferrable initially deferred)`
                yield* sql`insert into later values (${nightDrive})`
                const commit = sql.withTransaction(umwelt.Track.delete({ ids: [nightDrive] }))
                yield* fails(commit, { _tag: "SqlError" })
                expect(yield* remaining("Track")).toHaveLength(2)
                yield* sql`drop table later`
            })
        )

        it.effect("rejects keys and selections the input types do not allow", () =>
            Effect.gen(function* () {
                const { play } = yield* seed
                yield* invalid({ type: Play, where: {} })
                yield* invalid({ type: Play, where: { source: "car" }, allowAll: true })
                yield* invalid({ type: Play, where: { source: "car" }, ids: [play] })
                yield* invalid({ type: Play, where: false, ids: [play] })
                yield* invalid({ type: Play, ids: [] })
                yield* invalid({ type: Play, ids: [1] })
                yield* invalid({ type: Play, allowAll: false })
                yield* invalid({ type: Play, allowAll: true, where: false })
                yield* invalid({ type: Play, where: true })
                yield* invalid({ type: Play })
                yield* invalid({ type: Play, where: { nope: 1 } })
                yield* invalid({ type: Play, ids: [play], extra: 1 })
                yield* invalid({ type: [], allowAll: true })
                yield* invalid({ type: Umwelt.type("Other", { a: Schema.String }), allowAll: true })
                yield* invalid(null)
                yield* invalid({ type: Play, where: { source: { contains: "c" }, at: { contains: "2026" } } })
                yield* invalid({ type: Track, where: { seconds: { contains: "4" } } })
                const entry = { track: { slug: "night-drive" }, rating: 5 }
                yield* invalid({ type: Playlist, where: { entries: { equals: [{ ...entry, extra: 1 }] } } })
                expect(yield* remaining("Play")).toEqual([play])
            })
        )

        it.effect("fails with ModelMismatch unless Ledger's head is the chain's head", () =>
            Effect.gen(function* () {
                yield* seed
                const ahead = Umwelt.make(types, { migrations: aheadOf(chain) })
                yield* fails(ahead.Track.delete({ allowAll: true }), { _tag: "ModelMismatch", code: "ahead" })
                expect(yield* remaining("Track")).toHaveLength(2)
            })
        )
    })
})
