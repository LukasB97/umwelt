import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { get } from "../src/read/get.ts"
import { query } from "../src/read/query.ts"
import { resolveModel } from "../src/resolve.ts"
import { aheadOf, chainOf } from "./chain-fixture.ts"
import { TestDatabase, pgClient } from "./database.ts"
import {
    anyDate,
    Play,
    Playlist,
    Track,
    broken,
    chain,
    day,
    failure,
    model,
    seed,
    types,
    umwelt
} from "./query-fixture.ts"
const raw = (input: object) => failure(query(model, { type: Track, ...input }))
const slugs = (result: { readonly objects: readonly { readonly payload: { readonly slug: string } }[] }) =>
    result.objects.map((object) => object.payload.slug)

const seedAll = Effect.gen(function* () {
    yield* umwelt.deploy()
    yield* seed(Track, { slug: "night-drive", title: "Night Drive", seconds: 420, note: "b", tags: ["ambient"] })
    yield* seed(Track, { slug: "first-light", title: "First Light", seconds: 380, note: null, tags: [] })
    yield* seed(Track, { slug: "slow-tide", title: "Slow Tide", seconds: 500, tags: ["ambient"] })
    yield* seed(Track, { slug: "low-orbit", title: "Low Orbit", seconds: 610, note: "a", tags: [] })
    yield* seed(Play, { source: "car", track: { slug: "night-drive" }, queue: [], at: day(1) })
    yield* seed(Play, { source: "mobile", track: { slug: "first-light" }, queue: [], at: day(2) })
})

describe("query", () => {
    layer(TestDatabase("query_bare"))((it) => {
        it.effect("passes SqlError through unchanged", () =>
            Effect.gen(function* () {
                yield* broken
                expect(yield* failure(umwelt.Track.query({}))).toBe("SqlError")
            })
        )
    })

    layer(TestDatabase("query"))((it) => {
        it.effect("seeds", () => seedAll)

        it.effect("returns QueryObjects: type, Object ID, payload decoded through the codec, relations", () =>
            Effect.gen(function* () {
                const { objects } = yield* umwelt.Play.query({ where: { source: "car" } })
                expect(objects).toEqual([
                    {
                        type: "Play",
                        id: objects[0]?.id,
                        createdAt: anyDate,
                        changedAt: anyDate,
                        payload: { source: "car", track: { slug: "night-drive" }, queue: [], at: day(1) },
                        relations: {}
                    }
                ])
                expect(objects[0]?.id).toMatch(/^[0-9a-f-]{36}$/u)
                expect(objects[0]?.payload.at).toBeInstanceOf(Date)
            })
        )

        it.effect("filters with where, relation filters included", () =>
            Effect.gen(function* () {
                expect(slugs(yield* umwelt.Track.query({ where: { slug: "night-drive" } }))).toEqual(["night-drive"])
                const short = yield* umwelt.Play.query({ where: { track: { is: { seconds: { lt: 400 } } } } })
                expect(short.objects.map((play) => play.payload.source)).toEqual(["mobile"])
                expect(slugs(yield* umwelt.Track.query({ where: { slug: "nope" } }))).toEqual([])
            })
        )

        it.effect("orders by one field per entry in list order, null and absent last both ways", () =>
            Effect.gen(function* () {
                expect(slugs(yield* umwelt.Track.query({ orderBy: { seconds: "desc" } }))).toEqual([
                    "low-orbit",
                    "slow-tide",
                    "night-drive",
                    "first-light"
                ])
                expect(slugs(yield* umwelt.Track.query({ orderBy: [{ note: "asc" }, { slug: "asc" }] }))).toEqual([
                    "low-orbit",
                    "night-drive",
                    "first-light",
                    "slow-tide"
                ])
                expect(slugs(yield* umwelt.Track.query({ orderBy: [{ note: "desc" }, { slug: "desc" }] }))).toEqual([
                    "night-drive",
                    "low-orbit",
                    "slow-tide",
                    "first-light"
                ])
                const plays = yield* umwelt.Play.query({ orderBy: { at: "desc" } })
                expect(plays.objects.map((play) => play.payload.source)).toEqual(["mobile", "car"])
            })
        )

        it.effect("pages by take and skip; pageInfo tells whether Objects follow", () =>
            Effect.gen(function* () {
                const page = (take: number, skip: number) =>
                    umwelt.Track.query({ orderBy: { slug: "asc" }, take, skip })
                const first = yield* page(2, 0)
                expect([slugs(first), first.pageInfo]).toEqual([["first-light", "low-orbit"], { hasMore: true }])
                const last = yield* page(2, 2)
                expect([slugs(last), last.pageInfo]).toEqual([["night-drive", "slow-tide"], { hasMore: false }])
                expect(slugs(yield* page(0, 0))).toEqual([])
                expect((yield* umwelt.Track.query({ skip: 3, orderBy: { slug: "asc" } })).pageInfo).toEqual({
                    hasMore: false
                })
            })
        )

        it.effect("cursor continues after the Object it names, in the same order", () =>
            Effect.gen(function* () {
                const ordered = yield* umwelt.Track.query({ orderBy: [{ note: "asc" }, { seconds: "desc" }] })
                const [, second] = ordered.objects
                if (second === undefined) return yield* Effect.die(new Error("no second Track"))
                const rest = yield* umwelt.Track.query({
                    orderBy: [{ note: "asc" }, { seconds: "desc" }],
                    cursor: second.id,
                    take: 1
                })
                expect([slugs(rest), rest.pageInfo]).toEqual([["slow-tide"], { hasMore: true }])
                const nulls = yield* umwelt.Track.query({ orderBy: { note: "asc" }, cursor: second.id })
                expect(slugs(nulls).toSorted((a, b) => a.localeCompare(b))).toEqual(["first-light", "slow-tide"])
                const play = (yield* umwelt.Play.query({ where: { source: "car" } })).objects[0]?.id ?? ""
                expect(yield* query(model, { type: Track, cursor: play })).toEqual({
                    objects: [],
                    pageInfo: { hasMore: false }
                })
            })
        )

        it.effect("rejects keys the types do not allow, anywhere in input", () =>
            Effect.gen(function* () {
                for (const input of [
                    { nope: 1 },
                    { [Symbol("stray")]: 1 },
                    { where: {} },
                    { where: { nope: 1 } },
                    { take: -1 },
                    { take: 1.5 },
                    { take: "1" },
                    { skip: -2 },
                    { skip: Number.POSITIVE_INFINITY },
                    { orderBy: { title: "asc", slug: "desc" } },
                    { orderBy: { title: "up" } },
                    { orderBy: [] },
                    { orderBy: { tags: "asc" } },
                    { orderBy: { nope: "asc" } },
                    { cursor: 1 },
                    { include: true },
                    { where: { seconds: { contains: "4" } } },
                    { where: { tags: { lt: ["a"] } } }
                ])
                    expect(yield* raw(input)).toBe("ValidationFailed")
                expect(yield* failure(query(model, { type: Play, orderBy: { track: "asc" } }))).toBe("ValidationFailed")
                const Other = Umwelt.type("Track", { slug: Track.fields.slug })
                expect(yield* failure(query(model, { type: Other }))).toBe("ValidationFailed")
                expect(yield* failure(query(model, [Playlist]))).toBe("ValidationFailed")
            })
        )

        it.effect("fails with ModelMismatch while Ledger's head is not the chain's head", () =>
            Effect.gen(function* () {
                const ahead = Umwelt.make(types, { migrations: aheadOf(chain) })
                const error = yield* Effect.flip(ahead.Track.query({}))
                expect(error).toMatchObject({ _tag: "ModelMismatch", database: chain[0]?.id, code: "ahead" })
            })
        )
    })

    layer(TestDatabase("query_large"))((it) => {
        it.effect("reads more than 16 MiB: one row per root Object and per history entry", () =>
            Effect.gen(function* () {
                const Article = Umwelt.type(
                    "Article",
                    { slug: Schema.String, body: Schema.String },
                    { uniqueKey: Schema.Struct({ slug: Schema.String }), history: true }
                )
                const articles = Umwelt.make([Article], { migrations: chainOf([Article]) })
                yield* articles.deploy()
                const sql = yield* SqlClient.SqlClient
                yield* sql`insert into umwelt_object (type, identity, payload)
                    select 'Article', jsonb_build_object('slug', i::text),
                        jsonb_build_object('slug', i::text, 'body', repeat('x', 1000000))
                    from generate_series(1, 20) i`
                yield* sql`insert into umwelt_history (object, payload)
                    select id, payload from umwelt_object, generate_series(1, 20) where identity = '{"slug": "1"}'`
                expect((yield* articles.Article.query({})).objects).toHaveLength(20)
                expect(yield* articles.Article.history({ object: { slug: "1" } })).toHaveLength(20)
            })
        )
    })

    layer(TestDatabase("query_numbers"))((it) => {
        const Sample = Umwelt.type("Sample", {
            label: Schema.String,
            // oxlint-disable-next-line effecttsgo/schema-number -- non-finite values are what this test stores
            n: Schema.Number,
            // oxlint-disable-next-line effecttsgo/schema-number -- non-finite values are what this test stores
            s: Schema.NumberFromString
        })
        const samples = Umwelt.make([Sample], { migrations: chainOf([Sample]) })
        const values = [10, Number.POSITIVE_INFINITY, 9, Number.NEGATIVE_INFINITY, 0.5]
        const labels = (input: Parameters<typeof samples.Sample.query>[0]) =>
            Effect.map(samples.Sample.query(input), ({ objects }) => objects.map(({ payload }) => payload.label))

        it.effect("number fields sort and compare by numeric value, whatever their stored form", () =>
            Effect.gen(function* () {
                yield* samples.deploy()
                for (const value of values)
                    yield* samples.Sample.write({ data: { label: String(value), n: value, s: value } })
                const ascending = ["-Infinity", "0.5", "9", "10", "Infinity"]
                expect(yield* labels({ orderBy: { n: "asc" } })).toEqual(ascending)
                expect(yield* labels({ orderBy: { s: "asc" } })).toEqual(ascending)
                expect(yield* labels({ orderBy: { s: "desc" } })).toEqual(ascending.toReversed())
                expect(yield* labels({ where: { n: { gt: 9 } }, orderBy: { n: "asc" } })).toEqual(["10", "Infinity"])
                expect(yield* labels({ where: { s: { gt: 9 } }, orderBy: { n: "asc" } })).toEqual(["10", "Infinity"])
                expect(
                    yield* labels({ where: { s: { lt: Number.POSITIVE_INFINITY } }, orderBy: { s: "asc" } })
                ).toEqual(ascending.slice(0, 4))
                const [, second] = (yield* samples.Sample.query({ orderBy: { s: "asc" } })).objects
                if (second === undefined) return yield* Effect.die(new Error("no second Sample"))
                expect(yield* labels({ orderBy: { s: "asc" }, cursor: second.id, take: 2 })).toEqual(["9", "10"])
            })
        )
    })

    layer(TestDatabase("query_kinds"))((it) => {
        const Level = { Low: "low", High: "high" } as const
        const Task = Umwelt.type("Task", {
            name: Schema.suspend(() => Schema.String),
            level: Schema.Enum(Level),
            rank: Schema.Enum({ First: 1, Second: 2 })
        })
        const tasks = Umwelt.make([Task], { migrations: chainOf([Task]) })

        it.effect("suspended schemas and enums sort and filter by the kind of their values", () =>
            Effect.gen(function* () {
                yield* tasks.deploy()
                yield* tasks.Task.write({ data: { name: "alpha", level: Level.Low, rank: 2 } })
                yield* tasks.Task.write({ data: { name: "beta", level: Level.High, rank: 1 } })
                const names = (input: object) =>
                    Effect.map(tasks.Task.query(input), ({ objects }) => objects.map(({ payload }) => payload.name))
                expect(yield* names({ orderBy: { name: "desc" } })).toEqual(["beta", "alpha"])
                expect(yield* names({ where: { name: { contains: "lph" } } })).toEqual(["alpha"])
                expect(yield* names({ where: { name: { lt: "b" } } })).toEqual(["alpha"])
                expect(yield* names({ orderBy: { level: "asc" } })).toEqual(["beta", "alpha"])
                expect(yield* names({ where: { level: { contains: "ig" } } })).toEqual(["beta"])
                expect(yield* names({ where: { rank: { gt: 1 } }, orderBy: { rank: "asc" } })).toEqual(["alpha"])
            })
        )
    })

    layer(TestDatabase("query_declarations"))((it) => {
        it.effect("on a Model Check blocks, reads fail with ModelMismatch before they are planned", () =>
            Effect.gen(function* () {
                const Lost = Umwelt.type("Lost", { source: Schema.String, track: Umwelt.one("Track") })
                const lostChain = chainOf([Lost])
                const lost = resolveModel([Lost], lostChain)
                const mismatch = { _tag: "ModelMismatch", database: null, code: lostChain[0]?.id }
                for (const read of [
                    query(lost, { type: Lost, include: { track: true } }),
                    query(lost, { type: Lost, where: { track: { is: { title: "x" } } } }),
                    get(lost, { type: Lost, id: "x", include: { track: true } })
                ])
                    expect(yield* Effect.flip(read)).toMatchObject(mismatch)
            })
        )
    })

    layer(TestDatabase("query_index"))((it) => {
        it.effect("equality on a payload field is served by the payload index", () =>
            Effect.gen(function* () {
                yield* umwelt.deploy()
                const sql = yield* SqlClient.SqlClient
                yield* sql`insert into umwelt_object (type, identity, payload)
                    select 'Track', jsonb_build_object('slug', i::text),
                        jsonb_build_object('slug', i::text, 'title', 'T', 'seconds', i, 'tags', '[]'::jsonb)
                    from generate_series(1, 20000) i`
                yield* sql`analyze umwelt_object`
                const client = yield* pgClient("query_index")
                const sent: { readonly sql: string; readonly parameters: readonly unknown[] }[] = []
                const database = umwelt.promise((statement, parameters) => {
                    sent.push({ sql: statement, parameters })
                    return client.query<object>(statement, [...parameters]).then(({ rows }) => rows)
                })
                const found = yield* Effect.promise(() => database.Track.query({ where: { slug: "777" } }))
                expect(found.objects.map(({ payload }) => payload.slug)).toEqual(["777"])
                const read = sent.at(-1)
                if (read === undefined) return yield* Effect.die(new Error("no statement"))
                const { rows } = yield* Effect.promise(() =>
                    client.query<{ "QUERY PLAN": string }>(`explain (costs off) ${read.sql}`, [...read.parameters])
                )
                const plan = rows.map((row) => row["QUERY PLAN"]).join("\n")
                expect(plan).toContain("Index Scan on umwelt_object_payload")
            })
        )
    })
})
