import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlError } from "effect/sql"
import { ConditionRejected, Umwelt, ValidationFailed } from "../src/index.ts"
import { chainOf, reset } from "./chain-fixture.ts"
import { TestDatabase, pgClient, pgPool, rejection } from "./database.ts"

const Track = Umwelt.type(
    "Track",
    { slug: Schema.String, title: Schema.String },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)
const Play = Umwelt.type("Play", { track: Umwelt.one("Track"), at: Schema.Date })
const umwelt = Umwelt.make([Track, Play], { migrations: chainOf([Track, Play]) })

const nightDrive = { slug: "night-drive", title: "Night Drive" }
const firstLight = { slug: "first-light", title: "First Light" }
const at = new Date("2026-10-29T08:00:00.000Z")

/** Slugs of stored Tracks as another connection sees them: committed state only. */
const committed = Effect.map(umwelt.Track.query({ orderBy: { slug: "asc" } }), ({ objects }) =>
    objects.map((track) => track.payload.slug)
)

/** Same Identity twice across the list's end: the first entry applies, then the list fails. */
const failingList = [{ data: firstLight }, { data: nightDrive, mustNotExist: true }] as const

const deployed = Effect.gen(function* () {
    yield* reset
    yield* umwelt.deploy()
})

describe("Promise face", () => {
    layer(TestDatabase("promise"))((it) => {
        it.effect("on a pool: deploys, writes, reads, and throws the Effect face's error classes", () =>
            Effect.gen(function* () {
                yield* reset
                const database = umwelt.promise(yield* pgPool("promise"))
                expect((yield* Effect.promise(() => database.deploy())).applied).toHaveLength(1)
                const created = yield* Effect.promise(() => database.Track.write({ data: nightDrive }))
                expect(created.outcome).toBe("created")
                const play = yield* Effect.promise(() =>
                    database.Play.write({ data: { track: { slug: "night-drive" }, at } })
                )
                const read = yield* Effect.promise(() => database.Play.get({ id: play.id, include: { track: true } }))
                expect(read?.payload.at).toEqual(at)
                expect(read?.relations.track?.id).toBe(created.id)
                expect(yield* Effect.promise(() => database.check())).toEqual({ pending: [], blocking: [] })

                const rejected = yield* rejection(() => database.Track.write({ data: nightDrive, mustNotExist: true }))
                expect(rejected).toBeInstanceOf(ConditionRejected)
                expect(rejected).toMatchObject({ _tag: "ConditionRejected", reason: "mustNotExist" })
                const invalid = yield* rejection(() => database.write({ type: Track, data: { slug: "x" } }))
                expect(invalid).toBeInstanceOf(ValidationFailed)
            })
        )

        it.effect(
            "on a client outside a transaction: each operation commits on its own, completely or not at all",
            () =>
                Effect.gen(function* () {
                    yield* deployed
                    const client = yield* pgClient("promise")
                    const database = umwelt.promise(client)
                    yield* Effect.promise(() => database.Track.write({ data: nightDrive }))
                    expect(yield* committed).toEqual(["night-drive"])
                    yield* rejection(() => database.Track.write([...failingList]))
                    expect(yield* committed).toEqual(["night-drive"])
                    const { rows } = yield* Effect.promise(() =>
                        client.query<{ idle: boolean }>("select now() = statement_timestamp() as idle")
                    )
                    expect(rows).toEqual([{ idle: true }])
                })
        )

        it.effect(
            "inside the host's transaction: commits and rolls back with the host, its failure leaves nothing",
            () =>
                Effect.gen(function* () {
                    yield* deployed
                    const client = yield* pgClient("promise")
                    const database = umwelt.promise(client)
                    yield* Effect.promise(() => client.query("create temporary table note (text text)"))
                    yield* Effect.promise(() => client.query("begin"))
                    yield* Effect.promise(() => database.Track.write({ data: nightDrive }))
                    expect(yield* committed).toEqual([])
                    const failure = yield* rejection(() => database.Track.write([...failingList]))
                    expect(failure).toBeInstanceOf(ConditionRejected)
                    yield* Effect.promise(() => client.query("insert into note values ('kept')"))
                    yield* Effect.promise(() => client.query("commit"))
                    expect(yield* committed).toEqual(["night-drive"])
                    const notes = yield* Effect.promise(() => client.query<{ text: string }>("select text from note"))
                    expect(notes.rows).toEqual([{ text: "kept" }])

                    yield* Effect.promise(() => client.query("begin"))
                    yield* Effect.promise(() => database.Track.write({ data: firstLight }))
                    yield* Effect.promise(() => client.query("rollback"))
                    expect(yield* committed).toEqual(["night-drive"])
                })
        )

        it.effect("on a function running a host transaction's statements", () =>
            Effect.gen(function* () {
                yield* deployed
                const client = yield* pgClient("promise")
                const database = umwelt.promise((sql, parameters) =>
                    client.query<object>(sql, [...parameters]).then(({ rows }) => rows)
                )
                yield* Effect.promise(() => client.query("begin"))
                yield* Effect.promise(() => database.Track.write({ data: nightDrive }))
                const found = yield* Effect.promise(() => database.Track.query({ where: { slug: "night-drive" } }))
                expect(found.objects.map((track) => track.payload)).toEqual([nightDrive])
                yield* Effect.promise(() => client.query("rollback"))
                expect(yield* committed).toEqual([])
            })
        )

        it.effect("reads take no transaction; the gate reads Ledger's head row only", () =>
            Effect.gen(function* () {
                yield* deployed
                const client = yield* pgClient("promise")
                const sent: string[] = []
                const database = umwelt.promise((sql, parameters) => {
                    sent.push(sql)
                    return client.query<object>(sql, [...parameters]).then(({ rows }) => rows)
                })
                yield* Effect.promise(() => database.Track.write({ data: nightDrive }))
                const written = sent.length
                const found = yield* Effect.promise(() => database.Track.query({ where: { slug: "night-drive" } }))
                expect(found.objects.map(({ payload }) => payload)).toEqual([nightDrive])
                const read = sent.slice(written)
                expect(read).toHaveLength(2)
                expect(read.filter((sql) => /\b(begin|commit|savepoint|set_config)\b/u.test(sql))).toEqual([])
                const ledger = sent.filter((sql) => sql.includes("from umwelt_ledger"))
                expect(ledger).toHaveLength(2)
                for (const sql of ledger) expect(sql).toMatch(/order by position desc limit 1/u)
            })
        )

        it.effect("one executor value runs operations one at a time, also across Clients", () =>
            Effect.gen(function* () {
                yield* deployed
                const client = yield* pgClient("promise")
                const written = umwelt.promise(client).Track.write({ data: nightDrive })
                const failing = umwelt.promise(client).Track.write([...failingList])
                const settled = yield* Effect.promise(() => Promise.allSettled([written, failing]))
                expect(settled.map(({ status }) => status)).toEqual(["fulfilled", "rejected"])
                expect(yield* committed).toEqual(["night-drive"])
                const { rows } = yield* Effect.promise(() =>
                    client.query<{ idle: boolean }>("select now() = statement_timestamp() as idle")
                )
                expect(rows).toEqual([{ idle: true }])
            })
        )

        it.effect("throws the executor's failure as SqlError", () =>
            Effect.gen(function* () {
                const down = new Error("down")
                const database = umwelt.promise(() => Promise.reject(down))
                const error = yield* rejection(() => database.Track.query({}))
                expect(SqlError.isSqlError(error)).toBe(true)
                expect(error).toMatchObject({ reason: { cause: down } })
            })
        )
    })
})
