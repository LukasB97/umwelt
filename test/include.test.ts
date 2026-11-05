import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Umwelt } from "../src/index.ts"
import { query } from "../src/read/query.ts"
import { TestDatabase } from "./database.ts"
import { anyDate, Play, Playlist, Track, day, failure, model, seed, umwelt } from "./query-fixture.ts"

/** First payload field names the Object here: slug, source, or name. */
type Named = { readonly payload: { readonly [key: string]: unknown } }
const name = (object: Named | null | undefined) =>
    object === null || object === undefined ? null : Object.values(object.payload)[0]
const names = (objects: readonly Named[] | undefined) => (objects ?? []).map(name)

const seedAll = Effect.gen(function* () {
    yield* umwelt.deploy()
    yield* seed(Track, { slug: "night-drive", title: "Night Drive", seconds: 420, tags: [] })
    yield* seed(Track, { slug: "first-light", title: "First Light", seconds: 380, tags: [] })
    yield* seed(Track, { slug: "slow-tide", title: "Slow Tide", seconds: 500, tags: [] })
    const queue = [{ slug: "first-light" }, { slug: "gone" }, { slug: "night-drive" }, { slug: "first-light" }]
    yield* seed(Play, { source: "car", track: { slug: "night-drive" }, queue, at: day(1) })
    yield* seed(Play, { source: "mobile", track: { slug: "first-light" }, queue: [{ slug: "slow-tide" }], at: day(2) })
    yield* seed(Play, { source: "radio", track: { slug: "gone" }, queue: [], at: day(3) })
    yield* seed(Play, { source: "web", track: { slug: "night-drive" }, queue: [{ slug: "night-drive" }], at: day(4) })
    yield* seed(Playlist, {
        name: "road-trip",
        tracks: [{ slug: "night-drive" }, { slug: "first-light" }],
        opener: { slug: "slow-tide" }
    })
    yield* seed(Playlist, { name: "chill", tracks: [{ slug: "slow-tide" }] })
})

describe("include", () => {
    layer(TestDatabase("include"))((it) => {
        it.effect("seeds", () => seedAll)

        it.effect("one: target QueryObject beside payload, null for missing sparse target or absent field", () =>
            Effect.gen(function* () {
                const { objects } = yield* umwelt.Play.query({ orderBy: { at: "asc" }, include: { track: true } })
                expect(objects.map((play) => name(play.relations.track))).toEqual([
                    "night-drive",
                    "first-light",
                    null,
                    "night-drive"
                ])
                expect(objects[0]?.payload.track).toEqual({ slug: "night-drive" })
                expect(objects[0]?.relations.track).toEqual({
                    type: "Track",
                    id: objects[0]?.relations.track?.id,
                    createdAt: anyDate,
                    changedAt: anyDate,
                    payload: { slug: "night-drive", title: "Night Drive", seconds: 420, tags: [] },
                    relations: {}
                })
                const playlists = yield* umwelt.Playlist.query({ orderBy: { name: "desc" }, include: { opener: true } })
                expect(playlists.objects.map((playlist) => name(playlist.relations.opener))).toEqual([
                    "slow-tide",
                    null
                ])
            })
        )

        it.effect("many: list order, each Object once, missing sparse targets omitted", () =>
            Effect.gen(function* () {
                const { objects } = yield* umwelt.Play.query({ orderBy: { at: "asc" }, include: { queue: true } })
                expect(objects.map((play) => names(play.relations.queue))).toEqual([
                    ["first-light", "night-drive"],
                    ["slow-tide"],
                    [],
                    ["night-drive"]
                ])
            })
        )

        it.effect("refinement on collections pages per root Object", () =>
            Effect.gen(function* () {
                const queues = (result: { readonly objects: readonly { relations: { queue: Named[] } }[] }) =>
                    result.objects.map((play) => names(play.relations.queue))
                const ordered = yield* umwelt.Play.query({
                    orderBy: { at: "asc" },
                    include: { queue: { orderBy: { seconds: "desc" } } }
                })
                expect(queues(ordered)).toEqual([["night-drive", "first-light"], ["slow-tide"], [], ["night-drive"]])
                const paged = yield* umwelt.Play.query({
                    orderBy: { at: "asc" },
                    include: { queue: { take: 1, skip: 1 } }
                })
                expect(queues(paged)).toEqual([["night-drive"], [], [], []])
                const short = yield* umwelt.Play.query({
                    orderBy: { at: "asc" },
                    include: { queue: { where: { seconds: { lt: 400 } } } }
                })
                expect(queues(short)).toEqual([["first-light"], [], [], []])
                const { objects } = yield* umwelt.Playlist.query({
                    where: { name: "road-trip" },
                    include: { tracks: { take: 1 } }
                })
                expect(objects.map((playlist) => names(playlist.relations.tracks))).toEqual([["night-drive"]])
            })
        )

        it.effect("cursor inside a collection continues after the Object it names", () =>
            Effect.gen(function* () {
                const [firstLight] = (yield* umwelt.Track.query({ where: { slug: "first-light" } })).objects
                if (firstLight === undefined) return yield* Effect.die(new Error("no first-light"))
                const { objects } = yield* umwelt.Play.query({
                    where: { source: "car" },
                    include: { queue: { cursor: firstLight.id } }
                })
                expect(objects.map((play) => names(play.relations.queue))).toEqual([["night-drive"]])
            })
        )

        it.effect("reads relations backwards through RelationField under any key, with refinement", () =>
            Effect.gen(function* () {
                const { objects } = yield* umwelt.Track.query({
                    orderBy: { slug: "asc" },
                    include: {
                        plays: Play.fields.track.orderBy({ at: "desc" }),
                        early: Play.fields.track.where({ at: { lt: day(3) } }).take(1),
                        playlists: Playlist.fields.tracks,
                        queuedIn: Play.fields.queue.orderBy({ at: "asc" })
                    }
                })
                expect(
                    objects.map(({ relations }) => [
                        names(relations.plays),
                        names(relations.early),
                        names(relations.playlists),
                        names(relations.queuedIn)
                    ])
                ).toEqual([
                    [["mobile"], ["mobile"], ["road-trip"], ["car"]],
                    [["web", "car"], ["car"], ["road-trip"], ["car", "web"]],
                    [[], [], ["chill"], ["mobile"]]
                ])
                expect(objects[0]?.relations.plays[0]?.type).toBe("Play")
            })
        )

        it.effect("absence of an optional relation field is a field condition, also inside RelationField", () =>
            Effect.gen(function* () {
                const { objects } = yield* umwelt.Playlist.query({ where: { opener: Umwelt.absent } })
                expect(names(objects)).toEqual(["chill"])
                const opened = yield* umwelt.Playlist.query({ where: { NOT: { opener: Umwelt.absent } } })
                expect(names(opened.objects)).toEqual(["road-trip"])
                const tracks = yield* umwelt.Track.query({
                    orderBy: { slug: "asc" },
                    include: { unopened: Playlist.fields.tracks.where({ opener: Umwelt.absent }) }
                })
                expect(tracks.objects.map(({ relations }) => names(relations.unopened))).toEqual([[], [], ["chill"]])
            })
        )

        it.effect("nests include at any depth, forwards and backwards", () =>
            Effect.gen(function* () {
                const { objects } = yield* umwelt.Playlist.query({
                    where: { name: "road-trip" },
                    include: {
                        tracks: {
                            include: {
                                plays: Play.fields.track.orderBy({ at: "asc" }).include({
                                    track: { include: { playlists: Playlist.fields.tracks } },
                                    queue: { take: 1 }
                                })
                            }
                        }
                    }
                })
                const tracks = objects[0]?.relations.tracks ?? []
                expect(names(tracks)).toEqual(["night-drive", "first-light"])
                const [play] = tracks[0]?.relations.plays ?? []
                expect(name(play)).toBe("car")
                expect(name(play?.relations.track)).toBe("night-drive")
                expect(names(play?.relations.track?.relations.playlists)).toEqual(["road-trip"])
                expect(names(play?.relations.queue)).toEqual(["first-light"])
            })
        )

        it.effect("rejects include keys and refinements the types do not allow, also inside RelationField", () =>
            Effect.gen(function* () {
                const rejected = (type: object, include: unknown) =>
                    Effect.map(failure(query(model, { type, include })), (tag) => expect(tag).toBe("ValidationFailed"))
                yield* rejected(Play, { track: { take: 1 } })
                yield* rejected(Play, { track: { where: { slug: "night-drive" } } })
                yield* rejected(Play, { track: false })
                yield* rejected(Play, { source: true })
                yield* rejected(Track, { plays: true })
                yield* rejected(Play, { queue: { take: -1 } })
                yield* rejected(Play, { queue: { skip: 0.5 } })
                yield* rejected(Play, { queue: { nope: 1 } })
                yield* rejected(Play, { queue: { where: {} } })
                yield* rejected(Play, { queue: { orderBy: { title: "asc", slug: "asc" } } })
                yield* rejected(Play, { queue: { include: { plays: true } } })
                yield* rejected(Play, { track: Play.fields.track })
                yield* rejected(Playlist, { plays: Play.fields.track })
                yield* rejected(Track, { plays: Play.fields.track.take(-1) })
                yield* rejected(Track, { plays: Play.fields.track.skip(1.5) })
                yield* rejected(Track, { plays: Play.fields.track.include({ track: { take: 1 } }) })
                yield* rejected(Track, {
                    plays: { "~source": Play, "~field": "track", "~refinement": { where: { title: "K" } } }
                })
                const Stranger = Umwelt.type("Play", { track: Umwelt.one("Track") })
                yield* rejected(Track, { plays: Stranger.fields.track })
                yield* rejected(Track, { plays: { "~source": Play, "~field": "source", "~refinement": {} } })
            })
        )
    })
})
