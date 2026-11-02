import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Umwelt } from "../src/index.ts"
import { chainOf, reset } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"

const Track = Umwelt.type("Track", { slug: Schema.String }, { uniqueKey: Schema.Struct({ slug: Schema.String }) })
const fields = {
    title: Schema.String,
    track: Schema.NullOr(Umwelt.one("Track")),
    tracks: Schema.NullOr(Umwelt.many("Track"))
}
const NoteV1 = Umwelt.type("Note", fields)
const NoteV2 = Umwelt.type("Note", { ...fields, done: Schema.optionalKey(Schema.Boolean) })
const chain = chainOf([Track, NoteV1], [Track, NoteV2])
const v1 = Umwelt.make([Track, NoteV1], { migrations: chain.slice(0, 1) })
const v2 = Umwelt.make([Track, NoteV2], { migrations: chain })

describe("relation inside Schema.NullOr", () => {
    layer(TestDatabase("nullable"))((it) => {
        it.effect("null holds no reference: Write, Deploy, reads, and Delete skip it", () =>
            Effect.gen(function* () {
                yield* reset
                yield* v1.deploy()
                yield* v1.Note.write({ data: { title: "empty", track: null, tracks: null } })
                yield* v1.Track.write({ data: { slug: "night-drive" } })
                yield* v1.Note.write({
                    data: { title: "full", track: { slug: "night-drive" }, tracks: [{ slug: "night-drive" }] }
                })
                expect(yield* v2.deploy()).toEqual({ applied: [chain[1]?.id] })

                const { objects } = yield* v2.Note.query({
                    where: { track: { isNot: { slug: "night-drive" } } },
                    include: { track: true, tracks: true }
                })
                expect(
                    objects.map(({ payload, relations }) => [payload.title, relations.track, relations.tracks])
                ).toEqual([["empty", null, []]])
                const pointing = yield* v2.Track.query({ include: { notes: NoteV2.fields.tracks } })
                expect(pointing.objects[0]?.relations.notes.map(({ payload }) => payload.title)).toEqual(["full"])

                const blocked = yield* v2.Track.delete({ where: { slug: "night-drive" } })
                expect(blocked.blocked.map(({ blockedBy }) => blockedBy.map(({ field }) => field))).toEqual([
                    ["track", "tracks"]
                ])
                yield* v2.Note.delete({ where: { title: "full" } })
                expect((yield* v2.Track.delete({ where: { slug: "night-drive" } })).deleted).toHaveLength(1)
            })
        )
    })
})
