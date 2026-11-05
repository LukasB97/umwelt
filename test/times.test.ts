import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { query } from "../src/read/query.ts"
import { resolveModel } from "../src/resolve.ts"
import { remove } from "../src/write/delete.ts"
import { chainOf } from "./chain-fixture.ts"
import { TestDatabase, pgClient } from "./database.ts"
import { Play, Playlist, Track, day, failure } from "./query-fixture.ts"

const Stamped = Umwelt.type(
    "Stamped",
    { name: Schema.String, changedAt: Schema.String },
    { uniqueKey: Schema.Struct({ name: Schema.String }) }
)
const types = [Track, Play, Playlist, Stamped] as const
const chain = chainOf(types)
const umwelt = Umwelt.make(types, { migrations: chain })
const model = resolveModel(types, chain)

const slugs = (result: { readonly objects: readonly { readonly payload: { readonly slug: string } }[] }) =>
    result.objects.map((object) => object.payload.slug)

/** Stored times of one Track, set directly, since Write only knows the transaction's own time. */
const setTimes = (slug: string, created: Date, changed: Date) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`update umwelt_object set created = ${created.toISOString()}::timestamptz,
            changed = ${changed.toISOString()}::timestamptz
            where type = 'Track' and payload ->> 'slug' = ${slug}`
    })

/** Tracks a, b, c: created on days 1, 2, 3, changed on days 6, 5, 4. Play and Playlist point at a and c. */
const seedAll = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* umwelt.deploy()
    yield* sql`truncate umwelt_object cascade`
    yield* umwelt.write([
        { type: Track, data: { slug: "a", title: "A", seconds: 1, tags: [] } },
        { type: Track, data: { slug: "b", title: "B", seconds: 2, tags: [] } },
        { type: Track, data: { slug: "c", title: "C", seconds: 3, tags: [] } },
        { type: Play, data: { source: "car", track: { slug: "a" }, queue: [], at: day(1) } },
        { type: Play, data: { source: "radio", track: { slug: "c" }, queue: [], at: day(1) } },
        { type: Playlist, data: { name: "road-trip", tracks: [{ slug: "a" }] } }
    ])
    yield* setTimes("a", day(1), day(6))
    yield* setTimes("b", day(2), day(5))
    yield* setTimes("c", day(3), day(4))
})

const find = (where: Parameters<typeof umwelt.Track.query>[0]["where"]) =>
    Effect.map(umwelt.Track.query({ ...(where === undefined ? {} : { where }), orderBy: { slug: "asc" } }), slugs)

const invalid = (input: object) => failure(query(model, { type: Track, ...input }))

describe("times", () => {
    layer(TestDatabase("times"))((it) => {
        it.effect("where compares a time with a Date, a list, or lt and gt", () =>
            Effect.gen(function* () {
                yield* seedAll
                expect(yield* find({ [Umwelt.changedAt]: { gt: day(4) } })).toEqual(["a", "b"])
                expect(yield* find({ [Umwelt.changedAt]: { lt: day(6) } })).toEqual(["b", "c"])
                expect(yield* find({ [Umwelt.createdAt]: day(2) })).toEqual(["b"])
                expect(yield* find({ [Umwelt.createdAt]: { equals: day(3) } })).toEqual(["c"])
                expect(yield* find({ [Umwelt.createdAt]: { in: [day(1), day(3)] } })).toEqual(["a", "c"])
                expect(yield* find({ [Umwelt.createdAt]: { in: [] } })).toEqual([])
                expect(yield* find({ [Umwelt.createdAt]: { gt: day(1), lt: day(3) } })).toEqual(["b"])
            })
        )

        it.effect("a time sits beside fields and inside AND, OR, and NOT", () =>
            Effect.gen(function* () {
                yield* seedAll
                expect(yield* find({ title: "A", [Umwelt.createdAt]: { gt: day(1) } })).toEqual([])
                expect(yield* find({ title: "B", [Umwelt.createdAt]: { gt: day(1) } })).toEqual(["b"])
                expect(yield* find({ OR: [{ [Umwelt.createdAt]: day(1) }, { title: "C" }] })).toEqual(["a", "c"])
                expect(yield* find({ NOT: { [Umwelt.createdAt]: day(1) } })).toEqual(["b", "c"])
                expect(yield* find({ AND: [{ [Umwelt.changedAt]: { gt: day(4) } }, { title: "A" }] })).toEqual(["a"])
            })
        )

        it.effect("a time read back compares exactly: milliseconds are stored", () =>
            Effect.gen(function* () {
                yield* seedAll
                yield* umwelt.Track.write({ data: { slug: "fresh", title: "Fresh", seconds: 1, tags: [] } })
                const [fresh] = (yield* umwelt.Track.query({ where: { slug: "fresh" } })).objects
                if (fresh === undefined) return yield* Effect.die(new Error("no fresh Track"))
                const of = { slug: "fresh" }
                expect(yield* find({ ...of, [Umwelt.changedAt]: fresh.changedAt })).toEqual(["fresh"])
                expect(yield* find({ ...of, [Umwelt.changedAt]: { gt: fresh.changedAt } })).toEqual([])
                expect(yield* find({ ...of, [Umwelt.changedAt]: { lt: fresh.changedAt } })).toEqual([])
            })
        )

        it.effect("orderBy sorts by a time, beside fields, and pages by cursor", () =>
            Effect.gen(function* () {
                yield* seedAll
                const newest = yield* umwelt.Track.query({ orderBy: { [Umwelt.createdAt]: "desc" } })
                expect(slugs(newest)).toEqual(["c", "b", "a"])
                expect(slugs(yield* umwelt.Track.query({ orderBy: { [Umwelt.changedAt]: "asc" } }))).toEqual([
                    "c",
                    "b",
                    "a"
                ])
                const after = newest.objects[0]?.id
                if (after === undefined) return yield* Effect.die(new Error("no Track"))
                const page = yield* umwelt.Track.query({
                    orderBy: { [Umwelt.createdAt]: "desc" },
                    cursor: after,
                    take: 1
                })
                expect(slugs(page)).toEqual(["b"])
                yield* setTimes("b", day(3), day(5))
                expect(
                    slugs(yield* umwelt.Track.query({ orderBy: [{ [Umwelt.createdAt]: "desc" }, { title: "desc" }] }))
                ).toEqual(["c", "b", "a"])
            })
        )

        it.effect("relation filters read the time of the target, also with Identity fields beside it", () =>
            Effect.gen(function* () {
                yield* seedAll
                const sources = (where: Parameters<typeof umwelt.Play.query>[0]["where"]) =>
                    Effect.map(
                        umwelt.Play.query({ ...(where === undefined ? {} : { where }), orderBy: { source: "asc" } }),
                        (result) => result.objects.map((object) => object.payload.source)
                    )
                expect(yield* sources({ track: { is: { [Umwelt.createdAt]: { gt: day(1) } } } })).toEqual(["radio"])
                expect(yield* sources({ track: { is: { slug: "a", [Umwelt.createdAt]: { gt: day(1) } } } })).toEqual([])
                expect(yield* sources({ track: { is: { slug: "c", [Umwelt.createdAt]: { gt: day(1) } } } })).toEqual([
                    "radio"
                ])
                expect(
                    yield* sources({ track: { is: { OR: [{ slug: "a", [Umwelt.createdAt]: { gt: day(1) } }] } } })
                ).toEqual([])
                const names = (where: Parameters<typeof umwelt.Playlist.query>[0]["where"]) =>
                    Effect.map(umwelt.Playlist.query(where === undefined ? {} : { where }), (result) =>
                        result.objects.map((object) => object.payload.name)
                    )
                expect(yield* names({ tracks: { some: { slug: "a", [Umwelt.createdAt]: day(1) } } })).toEqual([
                    "road-trip"
                ])
                expect(yield* names({ tracks: { some: { slug: "a", [Umwelt.createdAt]: day(2) } } })).toEqual([])
            })
        )

        it.effect("include refines and sorts by a time, on collections and read backwards", () =>
            Effect.gen(function* () {
                yield* seedAll
                yield* umwelt.Playlist.write({
                    data: { name: "road-trip", tracks: [{ slug: "a" }, { slug: "b" }, { slug: "c" }] }
                })
                const { objects } = yield* umwelt.Playlist.query({
                    include: {
                        tracks: {
                            where: { [Umwelt.createdAt]: { gt: day(1) } },
                            orderBy: { [Umwelt.createdAt]: "desc" }
                        }
                    }
                })
                expect(objects[0]?.relations.tracks.map((track) => track.payload.slug)).toEqual(["c", "b"])
                const sql = yield* SqlClient.SqlClient
                yield* sql`update umwelt_object set created = ${day(9).toISOString()}::timestamptz where type = 'Play' and payload ->> 'source' = 'car'`
                const read = yield* umwelt.Track.query({
                    where: { slug: "a" },
                    include: { recent: Play.fields.track.where({ [Umwelt.createdAt]: { gt: day(8) } }) }
                })
                expect(read.objects[0]?.relations.recent.map((play) => play.payload.source)).toEqual(["car"])
                const none = yield* umwelt.Track.query({
                    where: { slug: "a" },
                    include: { recent: Play.fields.track.where({ [Umwelt.createdAt]: { lt: day(8) } }) }
                })
                expect(none.objects[0]?.relations.recent).toEqual([])
            })
        )

        it.effect("Delete keeps a time beside a field: only what both select goes", () =>
            Effect.gen(function* () {
                yield* seedAll
                const notes = yield* umwelt.Stamped.write([
                    { data: { name: "old", changedAt: "x" } },
                    { data: { name: "new", changedAt: "x" } }
                ])
                const sql = yield* SqlClient.SqlClient
                yield* sql`update umwelt_object set created = ${day(1).toISOString()}::timestamptz where id = ${notes[0]?.id ?? ""}`
                const result = yield* umwelt.Stamped.delete({
                    where: { changedAt: "x", [Umwelt.createdAt]: { lt: day(2) } }
                })
                expect(result.deleted.map((object) => object.id)).toEqual([notes[0]?.id])
                const left = yield* umwelt.Stamped.query({ where: { changedAt: "x" } })
                expect(left.objects.map((object) => object.payload.name)).toEqual(["new"])
            })
        )

        it.effect("a payload field named like a time stays a payload field", () =>
            Effect.gen(function* () {
                yield* seedAll
                yield* umwelt.Stamped.write({ data: { name: "own", changedAt: "by hand" } })
                const byField = yield* umwelt.Stamped.query({ where: { changedAt: "by hand" } })
                expect(byField.objects[0]?.payload.changedAt).toBe("by hand")
                expect(byField.objects[0]?.changedAt).toBeInstanceOf(Date)
                const byTime = yield* umwelt.Stamped.query({ where: { [Umwelt.changedAt]: { lt: day(1) } } })
                expect(byTime.objects).toEqual([])
            })
        )

        it.effect("fails with ValidationFailed on keys and values the types do not allow", () =>
            Effect.gen(function* () {
                yield* seedAll
                const other = Symbol("other")
                for (const where of [
                    { [other]: 1 },
                    { title: "A", [other]: 1 },
                    { [Umwelt.absent]: day(1) },
                    { [Umwelt.createdAt]: "yesterday" },
                    { [Umwelt.createdAt]: null },
                    { [Umwelt.createdAt]: Umwelt.absent },
                    { [Umwelt.createdAt]: new Date("nope") },
                    { [Umwelt.createdAt]: {} },
                    { [Umwelt.createdAt]: { gt: "yesterday" } },
                    { [Umwelt.createdAt]: { in: day(1) } },
                    { [Umwelt.createdAt]: { contains: "x" } }
                ])
                    expect(yield* invalid({ where })).toBe("ValidationFailed")
                for (const orderBy of [
                    { [other]: "asc" },
                    { [Umwelt.createdAt]: "up" },
                    { [Umwelt.createdAt]: "asc", title: "asc" },
                    { [Umwelt.createdAt]: "asc", [Umwelt.changedAt]: "asc" }
                ])
                    expect(yield* invalid({ orderBy })).toBe("ValidationFailed")
            })
        )

        it.effect("Query and Delete reject a stray symbol in time, field, and relation operators", () =>
            Effect.gen(function* () {
                yield* seedAll
                const stray = Symbol("stray")
                for (const [type, where] of [
                    [Track, { [Umwelt.createdAt]: { gt: day(1), [stray]: 1 } }],
                    [Track, { title: { contains: "A", [stray]: 1 } }],
                    [Play, { track: { is: { slug: "a" }, [stray]: 1 } }]
                ] as const) {
                    expect(yield* failure(query(model, { type, where }))).toBe("ValidationFailed")
                    expect(yield* failure(remove(model, { type, where }))).toBe("ValidationFailed")
                }
                expect(slugs(yield* umwelt.Track.query({ where: { title: { contains: "A" } } }))).toEqual(["a"])
            })
        )
    })

    layer(TestDatabase("times_index"))((it) => {
        it.effect("a page after a cursor seeks the time index to the cursor's time, in both directions", () =>
            Effect.gen(function* () {
                yield* umwelt.deploy()
                const sql = yield* SqlClient.SqlClient
                yield* sql`insert into umwelt_object (type, identity, payload, created)
                    select 'Track', jsonb_build_object('slug', i::text),
                        jsonb_build_object('slug', i::text, 'title', 'T', 'seconds', i, 'tags', '[]'::jsonb),
                        '2026-10-01T00:00:00Z'::timestamptz + i * interval '1 second'
                    from generate_series(1, 20000) i`
                yield* sql`analyze umwelt_object`
                const [middle] = (yield* umwelt.Track.query({ where: { slug: "10000" } })).objects
                if (middle === undefined) return yield* Effect.die(new Error("no middle Track"))
                const client = yield* pgClient("times_index")
                const sent: { readonly sql: string; readonly parameters: readonly unknown[] }[] = []
                const database = umwelt.promise((statement, parameters) => {
                    sent.push({ sql: statement, parameters })
                    return client.query<object>(statement, [...parameters]).then(({ rows }) => rows)
                })
                for (const [direction, next] of [
                    ["asc", "10001"],
                    ["desc", "9999"]
                ] as const) {
                    const page = yield* Effect.promise(() =>
                        database.Track.query({
                            orderBy: { [Umwelt.createdAt]: direction },
                            cursor: middle.id,
                            take: 1
                        })
                    )
                    expect(slugs(page)).toEqual([next])
                    const read = sent.at(-1)
                    if (read === undefined) return yield* Effect.die(new Error("no statement"))
                    const { rows } = yield* Effect.promise(() =>
                        client.query<{ "QUERY PLAN": string }>(`explain (costs off) ${read.sql}`, [...read.parameters])
                    )
                    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n")
                    expect(plan).toMatch(
                        direction === "asc" ? /Index Cond: .*created >= / : /Index Cond: .*created <= /
                    )
                }
            })
        )
    })
})
