import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Umwelt } from "../src/index.ts"
import { relationKey } from "../src/relation.ts"
import { Play, Playlist, Track } from "./model.ts"

describe("Umwelt.type", () => {
    it("is an Effect Struct of its fields with name, unique key, and options", () => {
        expect(Track.name).toBe("Track")
        expect(Object.keys(Track["~uniqueKey"])).toEqual(["slug"])
        expect(Playlist["~mutability"]).toEqual({ immutable: false, history: true })
        expect(Schema.decodeSync(Track)({ slug: "night-drive", title: "Night Drive", seconds: 420 })).toEqual({
            slug: "night-drive",
            title: "Night Drive",
            seconds: 420
        })
        expect(() => Schema.decodeUnknownSync(Track)({ slug: "night-drive" })).toThrow()
    })

    it("decodes a stored string to an Object ID", () => {
        expect(Schema.decodeSync(Track.ObjectId)("0b2c")).toBe("0b2c")
        expect(() => Schema.decodeUnknownSync(Track.ObjectId)(1)).toThrow()
    })

    it("makes relation fields RelationField values of their Type", () => {
        const recent = Play.fields.track.where({ source: "x" }).take(5)
        expect(Play.fields.track["~source"]).toBe(Play)
        expect(recent["~field"]).toBe("track")
        expect(recent["~target"]).toBe("Track")
        expect(recent["~refinement"]).toEqual({ where: { source: "x" }, take: 5 })
        expect(Play.fields.track["~refinement"]).toEqual({})
        expect(Playlist.fields.tracks.include({ x: true })["~include"]).toEqual({ x: true })
        expect("where" in Track.fields.slug).toBe(false)
    })
})

describe("relations", () => {
    it("annotate placeholders with target, cardinality, and mode", () => {
        expect(Umwelt.one("Track").ast.annotations?.[relationKey]).toEqual({
            target: "Track",
            card: "one",
            mode: "strict"
        })
        expect(Umwelt.one("Track").sparse()["~mode"]).toBe("sparse")
        const many = Umwelt.many("Track").sparse().ast
        expect(many._tag).toBe("Arrays")
        expect(many._tag === "Arrays" ? many.rest[0]?.annotations?.[relationKey] : undefined).toEqual({
            target: "Track",
            card: "many",
            mode: "sparse"
        })
    })
})

describe("migrations", () => {
    it("are their definitions", () => {
        const step = Umwelt.step({ before: null, after: { type: "object" } })
        expect(Umwelt.migration({ id: "a", parent: null, types: { Track: step } }).types["Track"]).toBe(step)
        expect(Umwelt.objectTable).toEqual({ name: "umwelt_object", id: "id", type: "type" })
    })
})
