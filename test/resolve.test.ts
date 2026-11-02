import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Umwelt } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { resolved } from "./model.ts"

const at = "2026-10-29T08:00:00.000Z"

describe("relation resolution", () => {
    it("decodes stored JSON with the target's Identity at relation positions", () => {
        const play = Schema.decodeSync(resolved("Play").json)({ source: "web", track: { slug: "night-drive" }, at })
        expect(play).toEqual({ source: "web", track: { slug: "night-drive" }, at: new Date(at) })
        expect(() => Schema.decodeSync(resolved("Play").json)({ source: "web", track: { title: "x" }, at })).toThrow()
    })

    it("resolves `many`, and relations nested in lists, keeping optional keys", () => {
        const decode = Schema.decodeSync(resolved("Playlist").json)
        const playlist = { name: "road-trip", tracks: [{ slug: "night-drive" }], tags: [] }
        expect(decode(playlist)).toEqual(playlist)
        const entries = [{ track: { slug: "first-light" }, rating: 5 }]
        expect(decode({ ...playlist, entries })).toEqual({ ...playlist, entries })
        expect(() => decode({ ...playlist, entries: [{ track: {}, rating: 5 }] })).toThrow()
    })

    it("encodes Payload to stored JSON", () => {
        const play = { source: "web", track: { slug: "night-drive" }, at: new Date(at) }
        expect(Schema.encodeSync(resolved("Play").json)(play)).toEqual({ ...play, at })
    })

    it("knows unique key, Identity, options, and top-level relation slots", () => {
        const playlist = resolved("Playlist")
        expect(playlist.uniqueKey).toEqual(["name"])
        expect(playlist.history).toBe(true)
        expect(resolved("Play").identity).toBeUndefined()
        expect(Schema.decodeSync(playlist.identity ?? Schema.Never)({ name: "road-trip" })).toEqual({
            name: "road-trip"
        })
        expect([...resolved("Play").slots]).toEqual([["track", { target: "Track", card: "one", mode: "sparse" }]])
        expect([...playlist.slots]).toEqual([["tracks", { target: "Track", card: "many", mode: "strict" }]])
        const Note = Umwelt.type("Note", {
            one: Schema.NullOr(Umwelt.one("Track")),
            many: Schema.NullOr(Umwelt.many("Track"))
        })
        expect([...(resolveModel([Note], []).types.get("Note")?.slots ?? [])]).toEqual([
            ["one", { target: "Track", card: "one", mode: "strict" }],
            ["many", { target: "Track", card: "many", mode: "strict" }]
        ])
    })

    it("names the chain's head by id and hash", () => {
        const first = Umwelt.migration({ id: "a", parent: null, types: {} })
        const model = resolveModel([], [first])
        expect(model.head?.id).toBe("a")
        expect(model.head?.hash).toMatch(/^sha256:[0-9a-f]{64}$/u)
        expect(resolveModel([], []).head).toBeNull()
    })

    it("leaves unresolvable targets as an empty object for Check to block", () => {
        const Lost = Umwelt.type("Lost", { to: Umwelt.one("Nowhere") })
        const lost = resolveModel([Lost], []).types.get("Lost")
        expect(lost?.relations).toEqual([
            {
                field: "to",
                path: '$."to" ? (@.type() != "null")',
                target: "Nowhere",
                mode: "strict",
                recursive: false,
                ambiguous: false
            }
        ])
    })
})
