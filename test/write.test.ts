import { createHash } from "node:crypto"
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { requireTargets } from "../src/write/targets.ts"
import { write } from "../src/write/write.ts"
import { aheadOf, chainOf } from "./chain-fixture.ts"
import { TestDatabase, concurrently } from "./database.ts"

const Track = Umwelt.type(
    "Track",
    {
        slug: Schema.String,
        title: Schema.String,
        seconds: Schema.Finite.check(Schema.isGreaterThan(0)),
        note: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)
const Play = Umwelt.type("Play", {
    track: Umwelt.one("Track"),
    queue: Umwelt.many("Track").sparse(),
    at: Schema.Date
})
const Playlist = Umwelt.type(
    "Playlist",
    {
        name: Schema.String,
        tracks: Umwelt.many("Track"),
        entries: Schema.optionalKey(Schema.Array(Schema.Struct({ track: Umwelt.one("Track"), rating: Schema.Finite })))
    },
    { uniqueKey: Schema.Struct({ name: Schema.String }), history: true }
)
const Recording = Umwelt.type(
    "Recording",
    { code: Schema.String, seconds: Schema.Finite },
    { uniqueKey: Schema.Struct({ code: Schema.String }), immutable: true }
)

const types = [Track, Play, Playlist, Recording] as const
const chain = chainOf(types)
const umwelt = Umwelt.make(types, { migrations: chain })
const model = resolveModel(types, chain)
const at = new Date("2026-10-29T08:00:00.000Z")
const later = new Date("2026-10-29T12:00:00.000Z")

const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`truncate umwelt_object cascade`
})

const stored = (type: string) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ payload: unknown }>`select payload from umwelt_object where type = ${type}
            order by payload::text`
        return rows.map((row) => row.payload)
    })

const historyRows = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ payload: unknown }>`select payload from umwelt_history order by position`
})

const fails = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, expected: object) =>
    Effect.map(Effect.flip(effect), (error) => expect(error).toMatchObject(expected))

const invalid = (input: unknown) => fails(write(model, input), { _tag: "ValidationFailed" })
const rejected = (input: unknown, reason: string) => fails(write(model, input), { _tag: "ConditionRejected", reason })

const nightDrive = { slug: "night-drive", title: "Night Drive", seconds: 420 }

/** Slugs JSON and SQL text escape differently, each its own Identity: backslashes, quotes, control characters, NFC and NFD. */
const nfd = `e${String.fromCodePoint(0x301)}`
const escapes = [
    "a\\b",
    "a\\\\b",
    "\\",
    "\\\\",
    "\\x41",
    "A",
    "\\u0041",
    "\\134",
    'q"uote',
    "line\nbreak",
    "line\\nbreak",
    "tab\t",
    "\u0001",
    "\u001f",
    "/slash",
    "\u{1F600}",
    nfd,
    nfd.normalize("NFC")
]

describe("write", () => {
    layer(TestDatabase("write"))((it) => {
        it.effect("deploys the Model", () => umwelt.deploy())

        it.effect("upsert creates, overlays, and returns unchanged for equal content", () =>
            Effect.gen(function* () {
                yield* reset
                const created = yield* umwelt.Track.write({ data: { ...nightDrive, note: "fast" } })
                expect(created.outcome).toBe("created")
                const changed = yield* umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive Remix" } })
                expect(changed).toEqual({ id: created.id, outcome: "changed" })
                expect(yield* umwelt.Track.write({ data: { slug: "night-drive", seconds: 420 } })).toEqual({
                    id: created.id,
                    outcome: "unchanged"
                })
                expect(yield* stored("Track")).toEqual([{ ...nightDrive, title: "Night Drive Remix", note: "fast" }])
            })
        )

        it.effect("overlay: absent removes optional fields, undefined is not given, null stays a value", () =>
            Effect.gen(function* () {
                yield* reset
                yield* umwelt.Track.write({ data: { ...nightDrive, note: "fast" } })
                yield* umwelt.Track.write({ data: { slug: "night-drive", note: null }, mustExist: true })
                expect(yield* stored("Track")).toEqual([{ ...nightDrive, note: null }])
                const kept = yield* write(model, {
                    type: Track,
                    data: { slug: "night-drive", title: undefined, note: undefined },
                    mustExist: true
                })
                expect(kept).toMatchObject({ outcome: "unchanged" })
                expect(yield* stored("Track")).toEqual([{ ...nightDrive, note: null }])
                yield* umwelt.Track.write({ data: { slug: "night-drive", note: Umwelt.absent }, mustExist: true })
                expect(yield* stored("Track")).toEqual([nightDrive])
                yield* invalid({ type: Track, data: { slug: "night-drive", title: Umwelt.absent } })
                yield* invalid({ type: Track, data: { ...nightDrive, title: undefined }, mustNotExist: true })
                yield* invalid({ type: Playlist, data: { name: "road-trip", tracks: [undefined] } })
                yield* invalid({
                    type: Playlist,
                    data: {
                        name: "road-trip",
                        tracks: [],
                        entries: [{ track: { slug: "night-drive" }, rating: Umwelt.absent }]
                    }
                })
            })
        )

        it.effect("mustNotExist creates complete state only", () =>
            Effect.gen(function* () {
                yield* reset
                expect((yield* umwelt.Track.write({ data: nightDrive, mustNotExist: true })).outcome).toBe("created")
                yield* rejected({ type: Track, data: nightDrive, mustNotExist: true }, "mustNotExist")
                yield* invalid({ type: Track, data: { slug: "first-light", title: "First Light" }, mustNotExist: true })
            })
        )

        it.effect("mustExist changes only an existing Object", () =>
            Effect.gen(function* () {
                yield* reset
                yield* rejected({ type: Track, data: nightDrive, mustExist: true }, "mustExist")
                expect(yield* stored("Track")).toEqual([])
                yield* umwelt.Track.write({ data: nightDrive })
                const result = yield* umwelt.Track.write({
                    data: { slug: "night-drive", seconds: 400 },
                    mustExist: true
                })
                expect(result.outcome).toBe("changed")
            })
        )

        it.effect("mustMatch compares supplied fields, absent meaning missing, ignoring key order", () =>
            Effect.gen(function* () {
                yield* reset
                yield* rejected({ type: Track, data: nightDrive, mustMatch: { title: "Night Drive" } }, "mustMatch")
                yield* umwelt.Track.write({ data: nightDrive })
                yield* rejected(
                    { type: Track, data: { slug: "night-drive", title: "X" }, mustMatch: { title: "Y" } },
                    "mustMatch"
                )
                yield* rejected({ type: Track, data: { slug: "night-drive" }, mustMatch: { note: null } }, "mustMatch")
                const renamed = yield* umwelt.Track.write({
                    data: { slug: "night-drive", title: "Night Drive Remix" },
                    mustMatch: { title: "Night Drive", note: Umwelt.absent }
                })
                expect(renamed.outcome).toBe("changed")
                yield* umwelt.Playlist.write({
                    data: { name: "road-trip", tracks: [], entries: [{ track: { slug: "night-drive" }, rating: 5 }] }
                })
                const playlist = yield* umwelt.Playlist.write({
                    data: { name: "road-trip", tracks: [{ slug: "night-drive" }] },
                    mustMatch: { entries: [{ rating: 5, track: { slug: "night-drive" } }] }
                })
                expect(playlist.outcome).toBe("changed")
            })
        )

        it.effect("rejects resulting states that fail the Type schema", () =>
            Effect.gen(function* () {
                yield* reset
                yield* invalid({ type: Track, data: { slug: "night-drive", title: "Night Drive" } })
                yield* invalid({ type: Track, data: { ...nightDrive, seconds: -1 } })
                yield* invalid({ type: Track, data: { ...nightDrive, seconds: "many" } })
                yield* invalid({
                    type: Playlist,
                    data: { name: "road-trip", tracks: [{ slug: "night-drive", extra: 1 }] }
                })
                expect(yield* stored("Track")).toEqual([])
            })
        )

        it.effect("rejects keys and shapes the input types do not allow", () =>
            Effect.gen(function* () {
                yield* reset
                yield* umwelt.Track.write({ data: nightDrive })
                const play = yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } })
                yield* invalid({ type: Track, data: nightDrive, extra: true })
                yield* invalid({ type: Track, data: { ...nightDrive, extra: true } })
                yield* invalid({ type: Track, data: nightDrive, mustExist: true, mustNotExist: true })
                yield* invalid({ type: Track, data: nightDrive, mustMatch: { title: "Night Drive" }, mustExist: true })
                yield* invalid({ type: Track, data: nightDrive, mustExist: false })
                yield* invalid({ type: Track, id: play.id, data: nightDrive })
                yield* invalid({ type: Track, data: { title: "Night Drive" } })
                yield* invalid({ type: Track, data: nightDrive, mustMatch: {} })
                yield* invalid({ type: Track, data: nightDrive, mustMatch: { title: undefined } })
                yield* invalid({ type: Track, data: nightDrive, mustMatch: { title: Umwelt.absent } })
                yield* invalid({ type: Track, data: nightDrive, mustMatch: { nope: 1 } })
                yield* invalid({ type: Play, data: { at }, mustExist: true, id: play.id })
                yield* invalid({
                    type: Play,
                    data: { track: { slug: "night-drive" }, queue: [], at },
                    mustMatch: { at }
                })
                yield* invalid({ type: Play, id: 1, data: { at } })
                yield* invalid({ type: Umwelt.type("Other", { a: Schema.String }), data: { a: "x" } })
                yield* invalid({ data: nightDrive })
                yield* invalid("night-drive")
                yield* invalid([{ type: Track, data: nightDrive }, null])
            })
        )

        it.effect("without unique key: no id creates, id overlays, mustMatch guards that Object", () =>
            Effect.gen(function* () {
                yield* reset
                yield* umwelt.Track.write({ data: nightDrive })
                const play = yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } })
                const other = yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } })
                expect(play.id).not.toBe(other.id)
                expect(yield* umwelt.Play.write({ id: play.id, data: { at: later } })).toEqual({
                    id: play.id,
                    outcome: "changed"
                })
                yield* rejected({ type: Play, id: play.id, data: { at }, mustMatch: { at } }, "mustMatch")
                const guarded = yield* umwelt.Play.write({ id: play.id, data: { at }, mustMatch: { at: later } })
                expect(guarded.outcome).toBe("changed")
                expect(yield* stored("Play")).toEqual([
                    { track: { slug: "night-drive" }, queue: [], at: at.toISOString() },
                    { track: { slug: "night-drive" }, queue: [], at: at.toISOString() }
                ])
            })
        )

        it.effect("unknown Object IDs reject with ConditionRejected", () =>
            Effect.gen(function* () {
                yield* reset
                const track = yield* umwelt.Track.write({ data: nightDrive })
                const play = yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } })
                const sql = yield* SqlClient.SqlClient
                yield* sql`delete from umwelt_object where id = ${play.id}`
                yield* rejected({ type: Play, id: play.id, data: { at } }, "unknownId")
                yield* rejected({ type: Play, id: track.id, data: { at } }, "unknownId")
                yield* rejected({ type: Play, id: "not an id", data: { at } }, "unknownId")
                yield* rejected({ type: Play, id: "not an id", data: { at }, mustMatch: { at } }, "unknownId")
            })
        )

        it.effect("immutable Types return unchanged for equal content and reject changes", () =>
            Effect.gen(function* () {
                yield* reset
                const recording = { code: "night-drive/1", seconds: 370 }
                expect((yield* umwelt.Recording.write({ data: recording })).outcome).toBe("created")
                expect((yield* umwelt.Recording.write({ data: recording, mustExist: true })).outcome).toBe("unchanged")
                yield* rejected({ type: Recording, data: { ...recording, seconds: 380 } }, "immutable")
                expect(yield* stored("Recording")).toEqual([recording])
            })
        )

        it.effect("lists apply in order, each entry seeing earlier ones; results in input order", () =>
            Effect.gen(function* () {
                yield* reset
                const results = yield* umwelt.write([
                    { type: Play, data: { track: { slug: "night-drive" }, queue: [], at } },
                    { type: Track, data: nightDrive },
                    {
                        type: Track,
                        data: { slug: "first-light", title: "First Light", seconds: 380 },
                        mustNotExist: true
                    },
                    {
                        type: Playlist,
                        data: { name: "road-trip", tracks: [{ slug: "night-drive" }, { slug: "first-light" }] }
                    }
                ])
                expect(results.map((result) => result.outcome)).toEqual(["created", "created", "created", "created"])
                const changed = yield* umwelt.Playlist.write([
                    { data: { name: "chill", tracks: [] }, mustNotExist: true },
                    { data: { name: "road-trip", tracks: [] }, mustExist: true }
                ])
                expect(changed.map((result) => result.outcome)).toEqual(["created", "changed"])
                const play = { id: yield* Schema.decodeEffect(Play.ObjectId)(results[0]?.id ?? "") }
                const twice = yield* umwelt.Play.write([
                    { id: play.id, data: { at: later } },
                    { id: play.id, data: { at }, mustMatch: { at: later } }
                ])
                expect(twice).toEqual([
                    { id: play.id, outcome: "changed" },
                    { id: play.id, outcome: "changed" }
                ])
                expect(yield* umwelt.write([])).toEqual([])
            })
        )

        it.effect("lists commit all or nothing", () =>
            Effect.gen(function* () {
                yield* reset
                yield* rejected(
                    [
                        { type: Track, data: nightDrive },
                        { type: Track, data: { slug: "first-light", title: "First Light", seconds: 380 } },
                        { type: Track, data: { slug: "slow-tide", seconds: 1 }, mustMatch: { seconds: 2 } }
                    ],
                    "mustMatch"
                )
                yield* invalid([
                    { type: Track, data: nightDrive },
                    { type: Track, data: { slug: "x", seconds: -1 } }
                ])
                expect(yield* stored("Track")).toEqual([])
            })
        )

        it.effect("same Identity twice in one list is DuplicateIdentity", () =>
            Effect.gen(function* () {
                yield* reset
                const duplicate = [
                    { type: Track, data: nightDrive },
                    { type: Track, data: { slug: "night-drive", title: "Other" }, mustExist: true }
                ]
                yield* fails(write(model, duplicate), { _tag: "DuplicateIdentity" })
                yield* umwelt.write([
                    { type: Track, data: nightDrive },
                    { type: Recording, data: { code: "night-drive", seconds: 1 } }
                ])
                expect(yield* stored("Track")).toEqual([nightDrive])
            })
        )

        it.effect("strict targets must exist after the list applied; sparse targets may be missing", () =>
            Effect.gen(function* () {
                yield* reset
                const missing = { _tag: "MissingTarget", type: "Track", identity: { slug: "night-drive" } }
                yield* fails(umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } }), missing)
                const nested = {
                    name: "road-trip",
                    tracks: [],
                    entries: [{ track: { slug: "night-drive" }, rating: 5 }]
                }
                yield* fails(umwelt.Playlist.write({ data: nested }), missing)
                yield* fails(
                    umwelt.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } }),
                    missing
                )
                expect(yield* stored("Play")).toEqual([])
                expect(yield* stored("Playlist")).toEqual([])
                const written = yield* umwelt.write([
                    { type: Playlist, data: nested },
                    { type: Play, data: { track: { slug: "night-drive" }, queue: [{ slug: "gone" }], at } },
                    { type: Track, data: nightDrive }
                ])
                expect(written).toHaveLength(3)
            })
        )

        it.effect("concurrent creates of one Identity: the later applies to the Object, its condition deciding", () =>
            Effect.gen(function* () {
                yield* reset
                const [created, upserting] = yield* concurrently(
                    umwelt.Track.write({ data: nightDrive }),
                    umwelt.Track.write({ data: { ...nightDrive, title: "Night Drive Remix" } })
                )
                expect(created.outcome).toBe("created")
                expect(yield* upserting).toEqual({ id: created.id, outcome: "changed" })
                expect(yield* stored("Track")).toEqual([{ ...nightDrive, title: "Night Drive Remix" }])

                yield* reset
                const [, error] = yield* concurrently(
                    umwelt.Track.write({ data: nightDrive, mustNotExist: true }),
                    Effect.flip(umwelt.Track.write({ data: { ...nightDrive, title: "Other" }, mustNotExist: true }))
                )
                expect(yield* error).toMatchObject({ _tag: "ConditionRejected", reason: "mustNotExist" })
                expect(yield* stored("Track")).toEqual([nightDrive])
            })
        )

        it.effect("createdAt on create, changedAt on every Write changing content, both from the database clock", () =>
            Effect.gen(function* () {
                yield* reset
                const sql = yield* SqlClient.SqlClient
                /** The effect in a transaction, with that transaction's `now()` read as Umwelt reads its times. */
                const clocked = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
                    sql.withTransaction(
                        Effect.gen(function* () {
                            const result = yield* effect
                            const [row] = yield* sql<{ now: string }>`select to_jsonb(now()) #>> '{}' as now`
                            return [result, new Date(row?.now ?? "")] as const
                        })
                    )
                const [{ id }, created] = yield* clocked(
                    umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive", seconds: 1 } })
                )
                const times = Effect.map(umwelt.Track.get({ id }), (object) => [object?.createdAt, object?.changedAt])
                expect(yield* times).toEqual([created, created])
                expect(
                    (yield* umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive" } })).outcome
                ).toBe("unchanged")
                expect(yield* times).toEqual([created, created])
                const [, changed] = yield* clocked(
                    umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive Remix" } })
                )
                expect(changed).not.toEqual(created)
                expect(yield* times).toEqual([created, changed])
            })
        )

        it.effect("createdAt and changedAt sit on included Objects in both directions", () =>
            Effect.gen(function* () {
                yield* reset
                yield* umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive", seconds: 1 } })
                yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } })
                const [play] = (yield* umwelt.Play.query({ include: { track: true } })).objects
                const [track] = (yield* umwelt.Track.query({ include: { plays: Play.fields.track } })).objects
                const timesOf = (object: { readonly createdAt: Date; readonly changedAt: Date } | null | undefined) => [
                    object?.createdAt,
                    object?.changedAt
                ]
                expect(timesOf(play?.relations.track)).toEqual(timesOf(track))
                expect(timesOf(track?.relations.plays[0])).toEqual(timesOf(play))
                expect(timesOf(play)).toEqual([expect.any(Date), expect.any(Date)])
                expect(timesOf(track)).toEqual([expect.any(Date), expect.any(Date)])
            })
        )

        it.effect("an Identity larger than 3 KB is written, read back, and kept unique", () =>
            Effect.gen(function* () {
                yield* reset
                const hex = (index: number) => createHash("sha256").update(String(index)).digest("hex")
                const slug = Array.from({ length: 64 }, (_, index) => hex(index)).join("")
                const { id, outcome } = yield* umwelt.Track.write({ data: { slug, title: "Long", seconds: 1 } })
                expect(outcome).toBe("created")
                expect((yield* umwelt.Track.get({ id }))?.payload.slug).toBe(slug)
                expect((yield* umwelt.Track.query({ where: { slug } })).objects.map((object) => object.id)).toEqual([
                    id
                ])
                expect((yield* umwelt.Track.write({ data: { slug, title: "Long" } })).outcome).toBe("unchanged")
                yield* umwelt.Play.write({ data: { track: { slug }, queue: [], at } })
                const sql = yield* SqlClient.SqlClient
                const duplicate = yield* Effect.flip(sql`insert into umwelt_object (type, identity, payload)
                    select type, identity, payload from umwelt_object where id = ${id}`)
                expect(duplicate._tag).toBe("SqlError")
            })
        )

        it.effect("history keeps the previous full state on every change", () =>
            Effect.gen(function* () {
                yield* reset
                yield* umwelt.Track.write({ data: nightDrive })
                yield* umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive Remix" } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [] } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } })
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [] } })
                expect((yield* historyRows).map((row) => row.payload)).toEqual([
                    { name: "road-trip", tracks: [] },
                    { name: "road-trip", tracks: [{ slug: "night-drive" }] }
                ])
            })
        )

        it.effect("a failed Write inside a host transaction leaves nothing of itself behind", () =>
            Effect.gen(function* () {
                yield* reset
                const sql = yield* SqlClient.SqlClient
                yield* sql`create table if not exists host_note (text text not null)`
                yield* sql.withTransaction(
                    Effect.gen(function* () {
                        yield* sql`insert into host_note values ('before')`
                        yield* umwelt.Track.write({ data: nightDrive })
                        yield* rejected(
                            [
                                { type: Track, data: { slug: "first-light", title: "First Light", seconds: 380 } },
                                { type: Track, data: nightDrive, mustNotExist: true }
                            ],
                            "mustNotExist"
                        )
                        yield* sql`insert into host_note values ('after')`
                    })
                )
                const notes = yield* sql<{ text: string }>`select text from host_note order by text`
                expect(notes.map((note) => note.text)).toEqual(["after", "before"])
                expect(yield* stored("Track")).toEqual([nightDrive])
            })
        )

        it.effect("fails with ModelMismatch unless Ledger's head is the chain's head", () =>
            Effect.gen(function* () {
                yield* reset
                const ahead = Umwelt.make(types, { migrations: aheadOf(chain) })
                const mismatch = { _tag: "ModelMismatch", database: chain[0]?.id, code: "ahead" }
                yield* fails(ahead.Track.write({ data: nightDrive }), mismatch)
                expect(yield* stored("Track")).toEqual([])
            })
        )

        it.effect("a Type delegate binds `type` and rejects it in its input", () =>
            Effect.gen(function* () {
                yield* reset
                const rejected = { _tag: "ValidationFailed" }
                // @ts-expect-error `type` is bound by the delegate
                yield* fails(umwelt.Track.write({ type: Track, data: nightDrive }), rejected)
                // @ts-expect-error `type` is bound by the delegate, in lists too
                yield* fails(umwelt.Track.write([{ type: Track, data: nightDrive }]), rejected)
                // @ts-expect-error `type` is bound by the delegate
                yield* fails(umwelt.Track.query({ type: Track }), rejected)
                expect(yield* stored("Track")).toEqual([])
            })
        )

        it.effect("SqlError passes through unchanged", () =>
            Effect.gen(function* () {
                yield* reset
                const sql = yield* SqlClient.SqlClient
                yield* sql`create function umwelt_test_refuse() returns trigger language plpgsql
                    as $$ begin raise exception 'refused'; end $$`
                yield* sql`create trigger refuse before insert on umwelt_object
                    for each row execute function umwelt_test_refuse()`
                yield* fails(umwelt.Track.write({ data: nightDrive }), { _tag: "SqlError" })
                yield* sql`drop trigger refuse on umwelt_object`
                yield* sql`drop function umwelt_test_refuse`
            })
        )
    })

    layer(TestDatabase("write_identity"))((it) => {
        it.effect("deploys the Model", () => umwelt.deploy())

        it.effect("Identity compares exactly through escapes and Unicode", () =>
            Effect.gen(function* () {
                yield* reset
                const sql = yield* SqlClient.SqlClient
                const ids: string[] = []
                for (const slug of escapes) {
                    const created = yield* umwelt.Track.write({ data: { slug, title: "t", seconds: 1 } })
                    const again = yield* umwelt.Track.write({ data: { slug, title: "t" } })
                    const found = yield* umwelt.Track.query({ where: { slug } })
                    expect([created.outcome, again, found.objects.map((object) => object.id)]).toEqual([
                        "created",
                        { id: created.id, outcome: "unchanged" },
                        [created.id]
                    ])
                    yield* umwelt.Play.write({ data: { track: { slug }, queue: [], at } })
                    const duplicate = yield* Effect.flip(sql`insert into umwelt_object (type, identity, payload)
                        select type, identity, payload from umwelt_object where id = ${created.id}`)
                    expect(duplicate._tag).toBe("SqlError")
                    ids.push(created.id)
                }
                expect(new Set(ids).size).toBe(escapes.length)
            })
        )

        it.effect("checks the targets of more written Objects than Postgres takes bind parameters", () =>
            Effect.gen(function* () {
                yield* reset
                const plays = model.types.get("Play")
                if (plays === undefined) return yield* Effect.die(new Error("no Play"))
                yield* umwelt.Track.write({ data: nightDrive })
                const play = yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, queue: [], at } })
                const ids = [play.id, ...Array.from({ length: 65_536 }, (_, index) => `unknown-${index}`)]
                yield* requireTargets([{ type: plays, ids }], { lock: true })
                const sql = yield* SqlClient.SqlClient
                yield* sql`update umwelt_object set payload = jsonb_set(payload, '{track}', '{"slug":"gone"}')
                    where id = ${play.id}`
                expect(yield* Effect.flip(requireTargets([{ type: plays, ids }], { lock: true }))).toMatchObject({
                    _tag: "MissingTarget",
                    identity: { slug: "gone" }
                })
            })
        )
    })
})
