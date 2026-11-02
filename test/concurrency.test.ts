import { describe, expect, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { chainOf, extend, reset, storedOf } from "./chain-fixture.ts"
import { TestDatabase, concurrently, lockWaits } from "./database.ts"

const key = { uniqueKey: Schema.Struct({ slug: Schema.String }) }
const TrackV1 = Umwelt.type("Track", { slug: Schema.String, duration: Schema.Finite }, key)
const TrackV2 = Umwelt.type("Track", { slug: Schema.String, seconds: Schema.Finite }, key)
const Tag = Umwelt.type(
    "Tag",
    { name: Schema.String, n: Schema.Finite },
    { uniqueKey: Schema.Struct({ name: Schema.String }) }
)
const first = chainOf([TrackV1, Tag])
const second = extend(first, [TrackV2, Tag], { Track: ({ duration, ...rest }) => ({ ...rest, seconds: duration }) })
const old = Umwelt.make([TrackV1, Tag], { migrations: first })
const next = Umwelt.make([TrackV2, Tag], { migrations: second })

const Track = Umwelt.type("Track", { slug: Schema.String }, key)
const Play = Umwelt.type("Play", { track: Umwelt.one("Track") })
const playChain = chainOf([Track, Play])
const plays = Umwelt.make([Track, Play], { migrations: playChain })
const grown = Umwelt.make([Track, Play, Tag], { migrations: extend(playChain, [Track, Play, Tag]) })

const deployedOld = Effect.gen(function* () {
    yield* reset
    yield* old.deploy()
    yield* old.Track.write({ data: { slug: "a", duration: 1 } })
    yield* old.Tag.write({ data: { name: "t", n: 1 } })
})

/** The effect, failing the test once it waits for a lock another transaction holds. */
const unblocked = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.raceFirst(effect, Effect.andThen(lockWaits(1), Effect.die(new Error("waits for a lock"))))

const payloads = (result: { readonly objects: readonly { readonly payload: unknown }[] }) =>
    result.objects.map(({ payload }) => payload)

const nightDrive = Effect.gen(function* () {
    yield* reset
    yield* plays.deploy()
    return (yield* plays.Track.write({ data: { slug: "night-drive" } })).id
})

describe("concurrency", () => {
    layer(TestDatabase("concurrency"))((it) => {
        it.effect("Deploy waits for a Write past the gate, then migrates what it wrote", () =>
            Effect.gen(function* () {
                yield* deployedOld
                const sql = yield* SqlClient.SqlClient
                const locked = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()
                const holding = sql.withTransaction(
                    Effect.gen(function* () {
                        yield* sql`select id from umwelt_object where type = 'Tag' for update`
                        yield* Deferred.succeed(locked, undefined)
                        yield* Deferred.await(release)
                    })
                )
                const holder = yield* Effect.forkChild(holding)
                yield* Deferred.await(locked)
                const writer = yield* Effect.forkChild(
                    old.write([
                        { type: Tag, data: { name: "t", n: 2 } },
                        { type: TrackV1, data: { slug: "late", duration: 100 } }
                    ])
                )
                yield* lockWaits(1)
                const deployer = yield* Effect.forkChild(next.deploy())
                yield* Effect.raceFirst(lockWaits(2), Fiber.await(deployer))
                yield* Deferred.succeed(release, undefined)
                yield* Fiber.join(holder)
                expect((yield* Fiber.join(writer)).map(({ outcome }) => outcome)).toEqual(["changed", "created"])
                expect(yield* Fiber.join(deployer)).toEqual({ applied: [second[1]?.id] })
                const { objects } = yield* storedOf("Track")
                expect(objects).toHaveLength(2)
                expect(objects).toEqual(
                    expect.arrayContaining([
                        { slug: "a", seconds: 1 },
                        { slug: "late", seconds: 100 }
                    ])
                )
            })
        )

        it.effect("A Write inside a host transaction holds Deploy back until the host commits", () =>
            Effect.gen(function* () {
                yield* deployedOld
                const [written, deploying, waited] = yield* concurrently(
                    old.Track.write({ data: { slug: "late", duration: 7 } }),
                    next.deploy()
                )
                expect([written.outcome, waited]).toEqual(["created", true])
                expect(yield* deploying).toEqual({ applied: [second[1]?.id] })
                expect((yield* storedOf("Track")).objects).toEqual(
                    expect.arrayContaining([
                        { slug: "a", seconds: 1 },
                        { slug: "late", seconds: 7 }
                    ])
                )
            })
        )

        it.effect("Deploy waits for a Delete in flight", () =>
            Effect.gen(function* () {
                yield* deployedOld
                const [deleted, deploying, waited] = yield* concurrently(
                    old.Track.delete({ where: { slug: "a" } }),
                    next.deploy()
                )
                expect([deleted.deleted.length, waited]).toEqual([1, true])
                expect(yield* deploying).toEqual({ applied: [second[1]?.id] })
                expect((yield* storedOf("Track")).objects).toEqual([])
            })
        )

        it.effect("Deploy's strict-target check takes no row locks: a row lock on a target holds it not", () =>
            Effect.gen(function* () {
                const track = yield* nightDrive
                yield* plays.Play.write({ data: { track: { slug: "night-drive" } } })
                const [, deploying, waited] = yield* concurrently(
                    Effect.flatMap(
                        SqlClient.SqlClient,
                        (sql) => sql`select id from umwelt_object where id = ${track} for update`
                    ),
                    grown.deploy()
                )
                expect(waited).toBe(false)
                expect((yield* deploying).applied).toHaveLength(1)
            })
        )

        it.effect("Writes wait for a Deploy in flight, then fail with ModelMismatch", () =>
            Effect.gen(function* () {
                yield* deployedOld
                const [, writing] = yield* concurrently(
                    next.deploy(),
                    old.Track.write({ data: { slug: "b", duration: 2 } })
                )
                expect(yield* Effect.flip(writing)).toMatchObject({
                    _tag: "ModelMismatch",
                    database: second[1]?.id,
                    code: first[0]?.id
                })
                expect((yield* storedOf("Track")).objects).toEqual([{ slug: "a", seconds: 1 }])
            })
        )

        it.effect(
            "Reads never wait for a Deploy in flight: they see the state before it, or fail with ModelMismatch",
            () =>
                Effect.gen(function* () {
                    yield* deployedOld
                    const sql = yield* SqlClient.SqlClient
                    const deployed = yield* Deferred.make<void>()
                    const commit = yield* Deferred.make<void>()
                    const deployer = yield* Effect.forkChild(
                        sql.withTransaction(
                            Effect.gen(function* () {
                                yield* next.deploy()
                                yield* Deferred.succeed(deployed, undefined)
                                yield* Deferred.await(commit)
                            })
                        )
                    )
                    yield* Deferred.await(deployed)
                    expect(payloads(yield* unblocked(old.Track.query({})))).toEqual([{ slug: "a", duration: 1 }])
                    expect(yield* Effect.flip(unblocked(next.Track.query({})))).toMatchObject({
                        _tag: "ModelMismatch",
                        database: first[0]?.id,
                        code: second[1]?.id
                    })
                    yield* Deferred.succeed(commit, undefined)
                    yield* Fiber.join(deployer)
                    expect(payloads(yield* next.Track.query({}))).toEqual([{ slug: "a", seconds: 1 }])
                })
        )

        it.effect("A read inside a host transaction holds no Deploy up; its next read fails with ModelMismatch", () =>
            Effect.gen(function* () {
                yield* deployedOld
                const sql = yield* SqlClient.SqlClient
                const read = yield* Deferred.make<void>()
                const deployed = yield* Deferred.make<void>()
                const host = yield* Effect.forkChild(
                    sql.withTransaction(
                        Effect.gen(function* () {
                            const before = yield* old.Track.query({})
                            yield* Deferred.succeed(read, undefined)
                            yield* Deferred.await(deployed)
                            return [before, yield* Effect.flip(old.Track.query({}))] as const
                        })
                    )
                )
                yield* Deferred.await(read)
                yield* unblocked(next.deploy())
                yield* Deferred.succeed(deployed, undefined)
                const [before, after] = yield* Fiber.join(host)
                expect(payloads(before)).toEqual([{ slug: "a", duration: 1 }])
                expect(after).toMatchObject({ _tag: "ModelMismatch", database: second[1]?.id, code: first[0]?.id })
            })
        )

        it.effect("Write of a strict source, then Delete of its target: the Delete waits and is blocked", () =>
            Effect.gen(function* () {
                const track = yield* nightDrive
                const [play, deleting] = yield* concurrently(
                    plays.Play.write({ data: { track: { slug: "night-drive" } } }),
                    plays.Track.delete({ ids: [track] })
                )
                const deleted = yield* deleting
                expect(deleted.deleted).toEqual([])
                expect(deleted.blocked).toEqual([
                    {
                        object: { type: "Track", id: track },
                        blockedBy: [{ source: { type: "Play", id: play.id }, field: "track" }]
                    }
                ])
            })
        )

        it.effect(
            "Delete of a target, then Write of a strict source: the Write waits and fails with MissingTarget",
            () =>
                Effect.gen(function* () {
                    const track = yield* nightDrive
                    const [deleted, writing] = yield* concurrently(
                        plays.Track.delete({ ids: [track] }),
                        plays.Play.write({ data: { track: { slug: "night-drive" } } })
                    )
                    expect(deleted.deleted).toEqual([{ type: "Track", id: track }])
                    expect(yield* Effect.flip(writing)).toMatchObject({
                        _tag: "MissingTarget",
                        type: "Track",
                        identity: { slug: "night-drive" }
                    })
                    expect((yield* storedOf("Play")).objects).toEqual([])
                })
        )
    })
})
