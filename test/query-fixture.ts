/** Model and stored Objects for Get and Query tests: rows go into umwelt_object directly, as Write would store them. */
import { expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt, type AnyType } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { chainOf } from "./chain-fixture.ts"

export const Track = Umwelt.type(
    "Track",
    {
        slug: Schema.String,
        title: Schema.String,
        seconds: Schema.Finite,
        note: Schema.optionalKey(Schema.NullOr(Schema.String)),
        tags: Schema.Array(Schema.String)
    },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)

export const Play = Umwelt.type("Play", {
    source: Schema.String,
    track: Umwelt.one("Track").sparse(),
    queue: Umwelt.many("Track").sparse(),
    at: Schema.Date
})

export const Playlist = Umwelt.type(
    "Playlist",
    { name: Schema.String, tracks: Umwelt.many("Track"), opener: Schema.optionalKey(Umwelt.one("Track")) },
    { uniqueKey: Schema.Struct({ name: Schema.String }) }
)

export const types = [Track, Play, Playlist] as const
export const chain = chainOf(types)
export const umwelt = Umwelt.make(types, { migrations: chain })
export const model = resolveModel(types, chain)

/** Umwelt's tables made by Deploy, then dropped: every read fails with SqlError. */
export const broken = Effect.gen(function* () {
    yield* umwelt.deploy()
    const sql = yield* SqlClient.SqlClient
    yield* sql`drop table umwelt_history, umwelt_object`
})

/** Stores one Object and returns its Object ID, decoded through the Type's ObjectId codec. */
export const seed = <I>(type: AnyType & { readonly ObjectId: Schema.Codec<I, string> }, payload: object) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const resolved = model.types.get(type.name)
        if (resolved === undefined) return yield* Effect.die(new Error(`no Type ${type.name}`))
        const stored = yield* Effect.orDie(Schema.encodeUnknownEffect(resolved.json)(payload))
        const identity =
            resolved.identity === undefined
                ? null
                : JSON.stringify(yield* Effect.orDie(Schema.encodeUnknownEffect(resolved.identity)(payload)))
        const [row] = yield* sql<{ id: string }>`insert into umwelt_object (type, identity, payload)
            values (${type.name}, ${identity}::jsonb, ${JSON.stringify(stored)}::jsonb) returning id`
        return yield* Effect.orDie(Schema.decodeUnknownEffect(type.ObjectId)(row?.id))
    })

/** Matches any Date, as createdAt and changedAt of Objects stored here. */
export const anyDate: unknown = expect.any(Date)

export const day = (date: number) => new Date(`2026-10-0${date}T08:00:00.000Z`)

/** The failure tag of an Effect expected to fail. */
export const failure = <E extends { readonly _tag: string }>(effect: Effect.Effect<unknown, E, SqlClient.SqlClient>) =>
    Effect.map(Effect.flip(effect), (error) => error._tag)
