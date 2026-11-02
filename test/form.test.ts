import { describe, expect, it } from "@effect/vitest"
import { canonicalJson, sha256 } from "../src/canonical.ts"
import { Umwelt } from "../src/index.ts"
import { migrationHash } from "../src/migration.ts"
import { resolveModel } from "../src/resolve.ts"
import { EscapedPart, Part, resolved } from "./model.ts"

const identity = { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] }
const notNull = ' ? (@.type() != "null")'

describe("serialized form", () => {
    it("is the stored side as JSON Schema with Umwelt annotations", () => {
        expect(resolved("Track").form).toEqual({
            type: "object",
            properties: {
                slug: { type: "string" },
                title: { type: "string" },
                seconds: { type: "number" },
                note: { anyOf: [{ type: "string" }, { type: "null" }] }
            },
            required: ["seconds", "slug", "title"],
            additionalProperties: true,
            "x-umwelt-unique-key": ["slug"]
        })
        expect(resolved("Play").form["properties"]).toEqual({
            source: { type: "string" },
            track: {
                ...identity,
                additionalProperties: true,
                "x-umwelt-relation": { target: "Track", card: "one", mode: "sparse" }
            },
            at: { type: "string" }
        })
    })

    it("marks history and many relations on their items", () => {
        const playlist = resolved("Playlist").form
        expect(playlist["x-umwelt-history"]).toBe(true)
        expect(playlist["properties"]).toMatchObject({
            tracks: { type: "array", items: { "x-umwelt-relation": { target: "Track", card: "many" } } }
        })
    })

    it("finds relations at any depth", () => {
        expect(resolved("Playlist").relations).toEqual([
            {
                field: "tracks",
                path: `$."tracks"[*]${notNull}`,
                target: "Track",
                mode: "strict",
                recursive: false,
                ambiguous: false
            },
            {
                field: "entries[].track",
                path: `$."entries"[*]."track"${notNull}`,
                target: "Track",
                mode: "strict",
                recursive: false,
                ambiguous: false
            }
        ])
    })
})

describe("recursive schema parts", () => {
    it("mark relations inside them, found down to the first recursion", () => {
        const Tree = Umwelt.type("Tree", { root: Part, top: Umwelt.one("Track") })
        const tree = resolveModel([Tree], []).types.get("Tree")
        expect(tree?.relations.map(({ field, recursive }) => [field, recursive])).toEqual([
            ["root.track", true],
            ["top", false]
        ])
    })

    it("are found through definitions whose names `$ref` escapes", () => {
        const Tree = Umwelt.type("Tree", { root: EscapedPart })
        const tree = resolveModel([Tree], []).types.get("Tree")
        expect(tree?.form["properties"]).toEqual({ root: { $ref: "#/$defs/Part~1of~0a%20tree%20%25" } })
        expect(tree?.relations.map(({ field, recursive }) => [field, recursive])).toEqual([["root.track", true]])
    })
})

describe("canonical JSON", () => {
    it("sorts keys at every depth and keeps arrays, null, and absent apart", () => {
        expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: null }], c: "x" } })).toBe(
            '{"a":{"c":"x","d":[{"y":null,"z":1}]},"b":1}'
        )
        expect(canonicalJson({ a: undefined })).toBe("{}")
        expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
        expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }))
    })

    it("hashes structure, not key order", () => {
        expect(sha256({ a: 1, b: [1, 2] })).toBe(sha256({ b: [1, 2], a: 1 }))
        expect(sha256({ a: 1 })).not.toBe(sha256({ a: 2 }))
        expect(sha256({})).toBe("sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
    })

    it("names a Migration by id, parent, and forms; `migrate` is not part of it", () => {
        const step = (migrate?: (old: { readonly slug: string }) => unknown) =>
            Umwelt.migration({
                id: "b",
                parent: { id: "a", hash: "sha256:0" },
                types: { Track: { before: identity, after: identity, ...(migrate === undefined ? {} : { migrate }) } }
            })
        const hash = migrationHash(step())
        expect(migrationHash(step((old) => ({ slug: `${old.slug} seconds` })))).toBe(hash)
        expect(migrationHash(step((old) => ({ slug: `${old.slug}seconds` })))).toBe(hash)
        expect(migrationHash(Umwelt.migration({ ...step(), id: "c" }))).not.toBe(hash)
        expect(migrationHash(Umwelt.migration({ ...step(), parent: { id: "a", hash: "sha256:1" } }))).not.toBe(hash)
        expect(
            migrationHash(Umwelt.migration({ ...step(), types: { Track: { before: null, after: identity } } }))
        ).not.toBe(hash)
    })
})
