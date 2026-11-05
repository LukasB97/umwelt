import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { get } from "../src/read/get.ts"
import { aheadOf, chainOf } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"
import { anyDate, Play, Track, broken, chain, day, failure, model, seed, types, umwelt } from "./query-fixture.ts"

const track = (slug: string) => seed(Track, { slug, title: slug, seconds: 1, tags: [] })

const Scored = Umwelt.type(
    "Scored",
    { slug: Schema.String, score: Schema.Finite.check(Schema.isGreaterThan(0)), at: Schema.Date },
    { uniqueKey: Schema.Struct({ slug: Schema.String }), history: true }
)
const scored = Umwelt.make([Scored], { migrations: chainOf([Scored]) })

describe("get", () => {
    layer(TestDatabase("get_bare"))((it) => {
        it.effect("passes SqlError through unchanged", () =>
            Effect.gen(function* () {
                yield* broken
                const id = yield* Effect.orDie(Schema.decodeEffect(Track.ObjectId)("x"))
                expect(yield* failure(umwelt.Track.get({ id }))).toBe("SqlError")
            })
        )
    })

    layer(TestDatabase("get_unchecked"))((it) => {
        it.effect("reads decode stored content without schema checks, still turning strings into Dates", () =>
            Effect.gen(function* () {
                const at = day(1)
                yield* scored.deploy()
                const { id } = yield* scored.Scored.write({ data: { slug: "a", score: 1, at } })
                yield* scored.Scored.write({ data: { slug: "a", score: 2 } })
                const sql = yield* SqlClient.SqlClient
                yield* sql`update umwelt_object set payload = jsonb_set(payload, '{score}', '-1')`
                yield* sql`update umwelt_history set payload = jsonb_set(payload, '{score}', '-1')`
                const stored = { slug: "a", score: -1, at }
                expect((yield* scored.Scored.get({ id }))?.payload).toEqual(stored)
                expect((yield* scored.Scored.query({})).objects.map(({ payload }) => payload)).toEqual([stored])
                expect((yield* scored.Scored.history({ object: id })).map(({ payload }) => payload)).toEqual([stored])
                expect(yield* failure(scored.Scored.write({ data: { slug: "a", at: day(2) } }))).toBe(
                    "ValidationFailed"
                )
            })
        )
    })

    layer(TestDatabase("get"))((it) => {
        it.effect("deploys the Model", () => umwelt.deploy())

        it.effect("one Object by Object ID as QueryObject", () =>
            Effect.gen(function* () {
                const id = yield* track("a")
                expect(yield* umwelt.Track.get({ id })).toEqual({
                    type: "Track",
                    id,
                    createdAt: anyDate,
                    changedAt: anyDate,
                    payload: { slug: "a", title: "a", seconds: 1, tags: [] },
                    relations: {}
                })
            })
        )

        it.effect("null for unknown, malformed, deleted, or another Type's Object ID", () =>
            Effect.gen(function* () {
                const play = yield* seed(Play, { source: "radio", track: { slug: "a" }, queue: [], at: day(1) })
                const gone = yield* track("gone")
                const sql = yield* SqlClient.SqlClient
                yield* sql`delete from umwelt_object where id = ${gone}`
                expect(yield* get(model, { type: Track, id: play })).toBeNull()
                expect(yield* get(model, { type: Track, id: "not-an-id" })).toBeNull()
                expect(yield* umwelt.Track.get({ id: gone })).toBeNull()
            })
        )

        it.effect("list in input order, null where unknown, repeats kept", () =>
            Effect.gen(function* () {
                const b = yield* track("b")
                const c = yield* track("c")
                const play = yield* seed(Play, { source: "radio", track: { slug: "b" }, queue: [], at: day(1) })
                const foreign = yield* Schema.decodeEffect(Track.ObjectId)(play)
                const found = yield* umwelt.Track.get({ ids: [c, foreign, b, c] })
                expect(found.map((object) => object?.payload.slug ?? null)).toEqual(["c", null, "b", "c"])
                const typed = yield* umwelt.Track.get({ ids: [b] })
                expect(typed.map((object) => object?.id)).toEqual([b])
            })
        )

        it.effect("include as in Query", () =>
            Effect.gen(function* () {
                yield* track("d")
                const play = yield* seed(Play, {
                    source: "radio",
                    track: { slug: "d" },
                    queue: [{ slug: "x" }],
                    at: day(2)
                })
                const found = yield* umwelt.Play.get({ id: play, include: { track: true, queue: true } })
                expect(found?.relations.track?.payload.slug).toBe("d")
                expect(found?.relations.queue).toEqual([])
                const [listed] = yield* umwelt.Play.get({ ids: [play], include: { track: true } })
                expect(listed?.relations.track?.payload.slug).toBe("d")
            })
        )

        it.effect("rejects keys the types do not allow, take or skip inside include", () =>
            Effect.gen(function* () {
                const id = yield* track("e")
                for (const input of [
                    {},
                    { id, [Symbol("stray")]: true },
                    { id, ids: [id] },
                    { ids: [] },
                    { ids: [id, 1] },
                    { id: 1 },
                    { id, nope: true },
                    { id, where: { slug: "e" } },
                    { id, include: { plays: Play.fields.track.take(-1) } },
                    { id, include: { plays: Play.fields.track.skip(0.5) } }
                ])
                    expect(yield* failure(get(model, { type: Track, ...input }))).toBe("ValidationFailed")
                expect(yield* failure(get(model, { type: Play, id, include: { queue: { take: 1.5 } } }))).toBe(
                    "ValidationFailed"
                )
            })
        )

        it.effect("takes more ids than Postgres takes bind parameters", () =>
            Effect.gen(function* () {
                const id = yield* track("many")
                const unknown = yield* Effect.orDie(Schema.decodeEffect(Track.ObjectId)("unknown"))
                const ids = [id, ...Array.from({ length: 65_536 }, () => unknown)] as const
                const found = yield* umwelt.Track.get({ ids })
                expect([found.length, found[0]?.id, found.filter((object) => object === null).length]).toEqual([
                    65_537,
                    id,
                    65_536
                ])
            })
        )

        it.effect("fails with ModelMismatch while Ledger's head is not the chain's head", () =>
            Effect.gen(function* () {
                const id = yield* track("f")
                const ahead = Umwelt.make(types, { migrations: aheadOf(chain) })
                expect(yield* failure(ahead.Track.get({ id }))).toBe("ModelMismatch")
                expect(yield* failure(ahead.Track.get({ ids: [id] }))).toBe("ModelMismatch")
            })
        )
    })
})
