import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { canonicalJson } from "../src/canonical.ts"
import { Umwelt } from "../src/index.ts"
import type { ResolvedType } from "../src/resolve.ts"
import { ensureLayout } from "../src/storage/tables.ts"
import { compileWhere } from "../src/where.ts"
import { TestDatabase } from "./database.ts"
import { model, resolved } from "./model.ts"

const Track = resolved("Track")
const Play = resolved("Play")
const Playlist = resolved("Playlist")

const seed = (type: ResolvedType, payload: object) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const stored = yield* Schema.encodeUnknownEffect(type.json)(payload)
        const identity =
            type.uniqueKey.length === 0
                ? null
                : canonicalJson(Object.fromEntries(type.uniqueKey.map((key) => [key, Reflect.get(payload, key)])))
        yield* sql`insert into umwelt_object (type, identity, payload)
            values (${type.name}, ${identity}::jsonb, ${JSON.stringify(stored)}::jsonb)`
    })

const day = (date: number) => new Date(`2026-10-0${date}T08:00:00.000Z`)

const seedAll = Effect.gen(function* () {
    yield* ensureLayout
    yield* seed(Track, { slug: "night-drive", title: "Night Drive", seconds: 420, note: "fast" })
    yield* seed(Track, { slug: "first-light", title: "First Light 100%", seconds: 380, note: null })
    yield* seed(Track, { slug: "slow-tide", title: "Slow Tide_x", seconds: 500 })
    yield* seed(Play, { source: "car", track: { slug: "night-drive" }, at: day(1) })
    yield* seed(Play, { source: "mobile", track: { slug: "first-light" }, at: day(2) })
    yield* seed(Play, { source: "radio", track: { slug: "gone" }, at: day(3) })
    yield* seed(Playlist, {
        name: "road-trip",
        tracks: [{ slug: "night-drive" }, { slug: "first-light" }],
        tags: ["a"],
        entries: [{ track: { slug: "night-drive" }, rating: 5 }]
    })
    yield* seed(Playlist, { name: "chill", tracks: [{ slug: "slow-tide" }], tags: [] })
    yield* seed(Playlist, { name: "focus", tracks: [], tags: ["a", "b"] })
})

/** Labels of the Objects of `type` matching `where`, sorted. */
const select = (type: ResolvedType, label: string, where: unknown) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const condition = yield* compileWhere(model, type, where, sql.literal("o"))
        const rows = yield* sql<{ label: string }>`select o.payload ->> ${label}::text as label
            from umwelt_object o where o.type = ${type.name} and ${condition} order by 1`
        return rows.map((row) => row.label)
    })

const track = (where: unknown) => select(Track, "slug", where)
const play = (where: unknown) => select(Play, "source", where)
const playlist = (where: unknown) => select(Playlist, "name", where)

const rejected = (effect: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
    Effect.map(Effect.flip(effect), (error) => expect(error).toMatchObject({ _tag: "ValidationFailed" }))

describe("where", () => {
    layer(TestDatabase("where"))((it) => {
        it.effect("seeds", () => seedAll)

        it.effect("matches scalar fields by bare value and operators", () =>
            Effect.gen(function* () {
                expect(yield* track({ slug: "night-drive" })).toEqual(["night-drive"])
                expect(yield* track({ seconds: { lt: 420 } })).toEqual(["first-light"])
                expect(yield* track({ seconds: { gt: 400, lt: 500 } })).toEqual(["night-drive"])
                expect(yield* track({ slug: { in: ["night-drive", "slow-tide"] } })).toEqual([
                    "night-drive",
                    "slow-tide"
                ])
                expect(yield* track({ slug: { in: [] } })).toEqual([])
                expect(yield* play({ at: day(2) })).toEqual(["mobile"])
                expect(yield* play({ at: { gt: new Date("2026-10-01T12:00:00.000Z") } })).toEqual(["mobile", "radio"])
            })
        )

        it.effect("keeps JSON null and absent fields apart", () =>
            Effect.gen(function* () {
                expect(yield* track({ note: null })).toEqual(["first-light"])
                expect(yield* track({ note: Umwelt.absent })).toEqual(["slow-tide"])
                expect(yield* track({ note: { lt: "z" }, title: undefined })).toEqual(["night-drive"])
                yield* rejected(track({ note: undefined }))
                yield* rejected(track({ title: Umwelt.absent }))
                yield* rejected(track({ note: { equals: Umwelt.absent } }))
                expect(yield* track({ note: { equals: "fast" } })).toEqual(["night-drive"])
                expect(yield* track({ note: { lt: "z" } })).toEqual(["night-drive"])
                expect(yield* track({ note: { contains: "as" } })).toEqual(["night-drive"])
            })
        )

        it.effect("contains matches text literally", () =>
            Effect.gen(function* () {
                expect(yield* track({ title: { contains: "100%" } })).toEqual(["first-light"])
                expect(yield* track({ title: { contains: "_" } })).toEqual(["slow-tide"])
                expect(yield* track({ title: { contains: "ght Dri" } })).toEqual(["night-drive"])
            })
        )

        it.effect("combines with AND, OR, NOT as two-valued logic", () =>
            Effect.gen(function* () {
                expect(yield* track({ OR: [{ slug: "night-drive" }, { seconds: { gt: 450 } }] })).toEqual([
                    "night-drive",
                    "slow-tide"
                ])
                expect(yield* track({ NOT: { note: "fast" } })).toEqual(["first-light", "slow-tide"])
                expect(yield* track({ AND: [{ seconds: { lt: 450 } }, { NOT: { slug: "first-light" } }] })).toEqual([
                    "night-drive"
                ])
                expect(yield* track({ title: { contains: "i" }, seconds: { gt: 400 } })).toEqual([
                    "night-drive",
                    "slow-tide"
                ])
            })
        )

        it.effect("compares object and array fields as stored JSON", () =>
            Effect.gen(function* () {
                expect(yield* playlist({ tags: { equals: ["a"] } })).toEqual(["road-trip"])
                expect(yield* playlist({ tags: { in: [[], ["a", "b"]] } })).toEqual(["chill", "focus"])
            })
        )

        it.effect("is and isNot: Identity fields read the reference, other fields the existing target", () =>
            Effect.gen(function* () {
                expect(yield* play({ track: { is: { slug: "gone" } } })).toEqual(["radio"])
                expect(yield* play({ track: { is: { title: "Night Drive" } } })).toEqual(["car"])
                expect(yield* play({ track: { isNot: { seconds: { lt: 400 } } } })).toEqual(["car", "radio"])
                expect(
                    yield* play({ track: { is: { OR: [{ slug: "first-light" }, { title: "Night Drive" }] } } })
                ).toEqual(["car", "mobile"])
            })
        )

        it.effect("some, every, none over many", () =>
            Effect.gen(function* () {
                expect(yield* playlist({ tracks: { some: { slug: "first-light" } } })).toEqual(["road-trip"])
                expect(yield* playlist({ tracks: { some: { seconds: { gt: 450 } } } })).toEqual(["chill"])
                expect(yield* playlist({ tracks: { every: { seconds: { lt: 450 } } } })).toEqual(["focus", "road-trip"])
                expect(yield* playlist({ tracks: { none: { slug: "night-drive" } } })).toEqual(["chill", "focus"])
                expect(
                    yield* playlist({ tracks: { some: { slug: "night-drive" }, none: { slug: "first-light" } } })
                ).toEqual([])
            })
        )

        it.effect("relation fields inside values compare the stored Identity", () =>
            Effect.gen(function* () {
                expect(yield* playlist({ entries: { some: { track: { is: { slug: "night-drive" } } } } })).toEqual([
                    "road-trip"
                ])
                yield* rejected(playlist({ entries: { some: { track: { is: { title: "Night Drive" } } } } }))
            })
        )

        it.effect("rejects keys the types do not allow and values that do not fit", () =>
            Effect.gen(function* () {
                yield* rejected(track({}))
                yield* rejected(track({ nope: 1 }))
                yield* rejected(track({ slug: { like: "k" } }))
                yield* rejected(track({ slug: {} }))
                yield* rejected(track({ AND: [] }))
                yield* rejected(track({ seconds: { lt: "many" } }))
                yield* rejected(track({ title: { contains: 1 } }))
                yield* rejected(playlist({ tags: ["a"] }))
                yield* rejected(play({ track: { some: { slug: "night-drive" } } }))
                yield* rejected(playlist({ tracks: { is: { slug: "night-drive" } } }))
                yield* rejected(play({ track: { slug: "night-drive" } }))
                yield* rejected(play({ track: { is: { nope: 1 } } }))
            })
        )

        it.effect("rejects operators the field kind does not take, and excess keys inside operands", () =>
            Effect.gen(function* () {
                yield* rejected(track({ seconds: { contains: "4" } }))
                yield* rejected(play({ at: { contains: "2026" } }))
                yield* rejected(playlist({ tags: { lt: ["b"] } }))
                yield* rejected(playlist({ tags: { contains: "a" } }))
                const entry = { track: { slug: "night-drive" }, rating: 5 }
                yield* rejected(playlist({ entries: { equals: [{ ...entry, extra: 1 }] } }))
                yield* rejected(
                    playlist({ entries: { in: [[{ ...entry, track: { slug: "night-drive", extra: 1 } }]] } })
                )
                expect(yield* playlist({ entries: { equals: [entry] } })).toEqual(["road-trip"])
            })
        )

        it.effect(
            "undefined means not given: Identity fields with undefined beside them still read the reference",
            () =>
                Effect.gen(function* () {
                    yield* seed(Playlist, { name: "lost", tracks: [{ slug: "gone" }, { slug: "slow-tide" }], tags: [] })
                    for (const unset of [{ title: undefined }, { [Umwelt.createdAt]: undefined }]) {
                        expect(yield* play({ track: { is: { slug: "gone", ...unset } } })).toEqual(["radio"])
                        expect(yield* play({ track: { isNot: { slug: "gone", ...unset } } })).toEqual(["car", "mobile"])
                        expect(yield* playlist({ tracks: { some: { slug: "gone", ...unset } } })).toEqual(["lost"])
                        expect(yield* playlist({ tracks: { every: { slug: "slow-tide", ...unset } } })).toEqual([
                            "chill",
                            "focus"
                        ])
                        expect(yield* playlist({ tracks: { none: { slug: "gone", ...unset } } })).toEqual([
                            "chill",
                            "focus",
                            "road-trip"
                        ])
                        expect(yield* play({ OR: [{ track: { is: { AND: [{ slug: "gone", ...unset }] } } }] })).toEqual(
                            ["radio"]
                        )
                    }
                })
        )
    })
})
