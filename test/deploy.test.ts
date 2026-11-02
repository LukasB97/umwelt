import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { AnyType, Fields } from "../src/declaration.ts"
import { Umwelt } from "../src/index.ts"
import type { Migration } from "../src/migration.ts"
import { resolveModel } from "../src/resolve.ts"
import { requireModel } from "../src/storage/gate.ts"
import {
    chainOf,
    extend,
    insertHistory,
    insertObject,
    ledgerOf,
    reset,
    storedOf,
    tableExists
} from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"

const key = { uniqueKey: Schema.Struct({ slug: Schema.String }) }
const TrackV1 = Umwelt.type("Track", { slug: Schema.String, duration: Schema.Finite }, { ...key, history: true })
const TrackV2 = Umwelt.type("Track", { slug: Schema.String, seconds: Schema.Finite }, { ...key, history: true })

/** Deploys the chain's first Migration, which holds TrackV1, so a test can store content before the rest. */
const deployed = (chain: readonly Migration[], types: readonly AnyType[]) =>
    Effect.gen(function* () {
        yield* reset
        yield* Umwelt.make([TrackV1], { migrations: chain.slice(0, 1) }).deploy()
        return Umwelt.make(types, { migrations: chain })
    })

const track = (slug: string, payload: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
        const id = yield* insertObject("Track", { slug, ...payload }, { slug })
        yield* insertHistory(id, { slug, duration: 1 })
        return id
    })

const renamed = extend(chainOf([TrackV1]), [TrackV2], {
    Track: ({ duration, ...rest }) => ({ ...rest, seconds: duration })
})

describe("Deploy", () => {
    layer(TestDatabase("deploy"))((it) => {
        it.effect(
            "first Deploy creates the tables, applies the chain, and writes the Ledger; the next applies nothing",
            () =>
                Effect.gen(function* () {
                    yield* reset
                    const types = [TrackV1, Umwelt.type("Tag", { name: Schema.String })]
                    const chain = chainOf([TrackV1], types)
                    const client = Umwelt.make(types, { migrations: chain })
                    expect(yield* client.deploy()).toEqual({ applied: chain.map(({ id }) => id) })
                    expect(yield* ledgerOf).toEqual(chain.map(({ id }) => id))
                    yield* requireModel(resolveModel(types, chain))
                    expect(yield* client.deploy()).toEqual({ applied: [] })
                })
        )

        it.effect("fails with Blocked and changes nothing", () =>
            Effect.gen(function* () {
                yield* reset
                const client = Umwelt.make([TrackV1], { migrations: [] })
                const error = yield* Effect.flip(client.deploy())
                expect(error).toMatchObject({ _tag: "Blocked", reasons: [{ kind: "chainBehindModel" }] })
                expect(yield* tableExists("umwelt_object")).toBe(false)
            })
        )

        it.effect("runs `migrate` over every Object and history entry", () =>
            Effect.gen(function* () {
                const client = yield* deployed(renamed, [TrackV2])
                yield* track("a", { duration: 120 })
                expect(yield* client.deploy()).toEqual({ applied: [renamed[1]?.id] })
                expect(yield* storedOf("Track")).toEqual({
                    objects: [{ slug: "a", seconds: 120 }],
                    history: [{ slug: "a", seconds: 1 }]
                })
            })
        )

        it.effect(
            "fails with MigrationFailed naming Object and cause when a result misses form after, and changes nothing",
            () =>
                Effect.gen(function* () {
                    const wrong = extend(chainOf([TrackV1]), [TrackV2], { Track: (old) => old })
                    const client = yield* deployed(wrong, [TrackV2])
                    const id = yield* track("a", { duration: 120 })
                    const error = yield* Effect.flip(client.deploy())
                    expect(error).toMatchObject({
                        _tag: "MigrationFailed",
                        migration: wrong[1]?.id,
                        type: "Track",
                        object: id
                    })
                    expect(error._tag === "MigrationFailed" ? error.cause : "").toMatch(/^result fails form after: /u)
                    expect((yield* storedOf("Track")).objects).toEqual([{ slug: "a", duration: 120 }])
                    expect(yield* ledgerOf).toEqual([wrong[0]?.id])
                })
        )

        it.effect("fails with MigrationFailed when `migrate` changes Identity or throws", () =>
            Effect.gen(function* () {
                const moved = extend(chainOf([TrackV1]), [TrackV2], {
                    Track: ({ duration }) => ({ slug: "other", seconds: duration })
                })
                const client = yield* deployed(moved, [TrackV2])
                const id = yield* track("a", { duration: 120 })
                expect(yield* Effect.flip(client.deploy())).toMatchObject({
                    _tag: "MigrationFailed",
                    object: id,
                    cause: "Identity changed"
                })
                const throwing = extend(chainOf([TrackV1]), [TrackV2], {
                    Track: () => {
                        throw new Error("boom")
                    }
                })
                const again = yield* deployed(throwing, [TrackV2])
                const other = yield* track("a", { duration: 120 })
                expect(yield* Effect.flip(again.deploy())).toMatchObject({
                    _tag: "MigrationFailed",
                    object: other,
                    cause: "migrate threw: boom"
                })
            })
        )

        it.effect("keeps absent and null apart in Identity: `migrate` turning one into the other fails", () =>
            Effect.gen(function* () {
                yield* reset
                const fields = { slug: Schema.String, code: Schema.optionalKey(Schema.NullOr(Schema.String)) }
                const keyed = { uniqueKey: Schema.Struct(fields) }
                const ItemV1 = Umwelt.type("Item", fields, keyed)
                const ItemV2 = Umwelt.type("Item", { ...fields, note: Schema.optionalKey(Schema.String) }, keyed)
                const chain = extend(chainOf([ItemV1]), [ItemV2], {
                    Item: (old) => ("code" in old ? old : { ...old, code: null })
                })
                const old = Umwelt.make([ItemV1], { migrations: chain.slice(0, 1) })
                yield* old.deploy()
                const { id } = yield* old.Item.write({ data: { slug: "a" } })
                const error = yield* Effect.flip(Umwelt.make([ItemV2], { migrations: chain }).deploy())
                expect(error).toMatchObject({ _tag: "MigrationFailed", object: id, cause: "Identity changed" })
                expect((yield* storedOf("Item")).objects).toEqual([{ slug: "a" }])
            })
        )

        it.effect("drops what a destructive step drops, from Objects and history", () =>
            Effect.gen(function* () {
                const Lean = Umwelt.type("Track", { slug: Schema.String }, { ...key, history: true })
                const chain = chainOf([TrackV1], [Lean])
                const client = yield* deployed(chain, [Lean])
                yield* track("a", { duration: 120 })
                yield* client.deploy()
                expect(yield* storedOf("Track")).toEqual({ objects: [{ slug: "a" }], history: [{ slug: "a" }] })
            })
        )

        it.effect("drops history when the Type stops keeping it", () =>
            Effect.gen(function* () {
                const NoHistory = Umwelt.type("Track", { slug: Schema.String, duration: Schema.Finite }, key)
                const chain = chainOf([TrackV1], [NoHistory])
                const client = yield* deployed(chain, [NoHistory])
                yield* track("a", { duration: 120 })
                yield* client.deploy()
                expect(yield* storedOf("Track")).toEqual({ objects: [{ slug: "a", duration: 120 }], history: [] })
            })
        )

        it.effect("proves a safe step against stored content", () =>
            Effect.gen(function* () {
                const Noted = (fields: Fields) =>
                    Umwelt.type(
                        "Track",
                        { slug: Schema.String, duration: Schema.Finite, ...fields },
                        { ...key, history: true }
                    )
                const added = Noted({ note: Schema.optionalKey(Schema.String) })
                const chain = chainOf([TrackV1], [added])
                const client = yield* deployed(chain, [added])
                const id = yield* track("a", { duration: 120, note: 7 })
                const error = yield* Effect.flip(client.deploy())
                expect(error).toMatchObject({
                    _tag: "MigrationFailed",
                    migration: chain[1]?.id,
                    type: "Track",
                    object: id
                })
            })
        )

        it.effect("keeps createdAt and changedAt", () =>
            Effect.gen(function* () {
                yield* deployed(renamed, [TrackV2])
                const client = Umwelt.make([TrackV2], { migrations: renamed })
                const old = Umwelt.make([TrackV1], { migrations: renamed.slice(0, 1) })
                yield* old.Track.write({ data: { slug: "a", duration: 1 } })
                yield* old.Track.write({ data: { slug: "a", duration: 2 } })
                const [before] = (yield* old.Track.query({})).objects
                yield* client.deploy()
                const [after] = (yield* client.Track.query({})).objects
                expect(before?.changedAt).toBeInstanceOf(Date)
                expect(after?.payload).toEqual({ slug: "a", seconds: 2 })
                expect([after?.createdAt, after?.changedAt]).toEqual([before?.createdAt, before?.changedAt])
            })
        )

        it.effect("migrates immutable Types too", () =>
            Effect.gen(function* () {
                yield* reset
                const frozen = { uniqueKey: Schema.Struct({ code: Schema.String }), immutable: true } as const
                const RecordingV1 = Umwelt.type("Recording", { code: Schema.String, duration: Schema.Finite }, frozen)
                const RecordingV2 = Umwelt.type("Recording", { code: Schema.String, seconds: Schema.Finite }, frozen)
                const chain = extend(chainOf([RecordingV1]), [RecordingV2], {
                    Recording: ({ duration, ...rest }) => ({ ...rest, seconds: duration })
                })
                const old = Umwelt.make([RecordingV1], { migrations: chain.slice(0, 1) })
                yield* old.deploy()
                yield* old.Recording.write({ data: { code: "night-drive/1", duration: 370 } })
                const client = Umwelt.make([RecordingV2], { migrations: chain })
                expect(yield* client.deploy()).toEqual({ applied: [chain[1]?.id] })
                const { objects } = yield* client.Recording.query({})
                expect(objects.map(({ payload }) => payload)).toEqual([{ code: "night-drive/1", seconds: 370 }])
            })
        )

        it.effect("fails with MissingTarget when a strict relation lost its target after the Migrations", () =>
            Effect.gen(function* () {
                yield* reset
                const Play = (track: Schema.Top) => Umwelt.type("Play", { track })
                const sparse = [TrackV1, Play(Umwelt.one("Track").sparse())]
                const strict = [TrackV1, Play(Umwelt.one("Track"))]
                const chain = chainOf(sparse, strict)
                yield* Umwelt.make(sparse, { migrations: chain.slice(0, 1) }).deploy()
                yield* insertObject("Play", { track: { slug: "gone" } })
                const error = yield* Effect.flip(Umwelt.make(strict, { migrations: chain }).deploy())
                expect(error).toMatchObject({ _tag: "MissingTarget", type: "Track", identity: { slug: "gone" } })
                expect(yield* ledgerOf).toEqual([chain[0]?.id])
            })
        )
    })
})
