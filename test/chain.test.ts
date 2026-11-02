import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { chainReasons, changesOf, fold } from "../src/chain/chain.ts"
import { kindOf } from "../src/chain/classify.ts"
import { declarationReasons } from "../src/chain/declarations.ts"
import type { Fields } from "../src/declaration.ts"
import { Umwelt } from "../src/index.ts"
import { migrationHash } from "../src/migration.ts"
import { resolveModel } from "../src/resolve.ts"
import { chainOf, extend } from "./chain-fixture.ts"

const key = { uniqueKey: Schema.Struct({ slug: Schema.String }) }

const formOf = (fields: Fields, options: { readonly history?: boolean } = {}) => {
    const form = resolveModel(
        [Umwelt.type("T", { slug: Schema.String, ...fields }, { ...key, ...options })],
        []
    ).types.get("T")?.form
    if (form === undefined) throw new Error("no form")
    return form
}

const kind = (before: Fields, after: Fields) => kindOf({ before: formOf(before), after: formOf(after) })

describe("form", () => {
    it("drops documentation, so a doc change is no change", () => {
        const plain = formOf({ title: Schema.String })
        const documented = formOf({
            title: Schema.String.annotate({
                title: "Title",
                description: "Title of the track",
                examples: ["Night Drive"]
            })
        })
        expect(documented).toEqual(plain)
    })

    it("keeps fields named like annotations", () => {
        expect(formOf({ title: Schema.String, description: Schema.String })["properties"]).toMatchObject({
            title: { type: "string" },
            description: { type: "string" }
        })
    })
})

describe("classification", () => {
    it("is safe when stored content fits unchanged", () => {
        expect(kind({}, { note: Schema.optionalKey(Schema.String) })).toBe("safe")
        expect(kind({ n: Schema.String }, { n: Schema.Union([Schema.String, Schema.Finite]) })).toBe("safe")
        expect(kind({ n: Schema.Int }, { n: Schema.Finite })).toBe("safe")
        expect(kind({ n: Schema.Literals(["a"]) }, { n: Schema.Literals(["a", "b"]) })).toBe("safe")
    })

    it("is transforming when stored content may not fit", () => {
        expect(kind({}, { seconds: Schema.Finite })).toBe("transforming")
        expect(kind({ n: Schema.String }, { n: Schema.Finite })).toBe("transforming")
        expect(kind({ n: Schema.optionalKey(Schema.String) }, { n: Schema.String })).toBe("transforming")
        expect(kind({ n: Schema.Literals(["a", "b"]) }, { n: Schema.Literals(["a"]) })).toBe("transforming")
    })

    it("is destructive when content fits once dropped fields are gone, at any depth", () => {
        expect(kind({ duration: Schema.Finite }, {})).toBe("destructive")
        const entry = (fields: Fields) => ({
            entries: Schema.Array(Schema.Struct({ rating: Schema.Finite, ...fields }))
        })
        expect(kind(entry({ note: Schema.String }), entry({}))).toBe("destructive")
        expect(kind(entry({ note: Schema.String }), entry({ label: Schema.String }))).toBe("transforming")
    })

    it("drops history as destructive; new Type safe, removed Type destructive", () => {
        expect(kindOf({ before: formOf({}, { history: true }), after: formOf({}) })).toBe("destructive")
        expect(kindOf({ before: formOf({}), after: formOf({}, { history: true }) })).toBe("safe")
        expect(kindOf({ before: null, after: formOf({}) })).toBe("safe")
        expect(kindOf({ before: formOf({}), after: null })).toBe("destructive")
    })

    it("compares recursive definitions", () => {
        interface Node {
            readonly name: string
            readonly children: readonly Node[]
        }
        interface Noted extends Node {
            readonly note?: string
            readonly children: readonly Noted[]
        }
        const NodeV1: Schema.Codec<Node> = Schema.Struct({
            name: Schema.String,
            children: Schema.Array(Schema.suspend(() => NodeV1))
        }).annotate({ identifier: "Node" })
        const NodeV2: Schema.Codec<Noted> = Schema.Struct({
            name: Schema.String,
            note: Schema.optionalKey(Schema.String),
            children: Schema.Array(Schema.suspend(() => NodeV2))
        }).annotate({ identifier: "Node" })
        expect(kind({ root: NodeV1 }, { root: NodeV2 })).toBe("safe")
        expect(kind({ root: NodeV2 }, { root: NodeV1 })).toBe("destructive")
    })

    it("compares definitions under names `$ref` escapes", () => {
        const named = (fields: Fields) => Schema.Struct(fields).annotate({ identifier: "Part/of~a tree %" })
        const before = formOf({ part: named({ a: Schema.String }) })
        expect(before["properties"]).toMatchObject({ part: { $ref: "#/$defs/Part~1of~0a%20tree%20%25" } })
        expect(kindOf({ before, after: formOf({ part: named({ a: Schema.String, b: Schema.String }) }) })).toBe(
            "transforming"
        )
    })
})

const Track = (fields: Fields = {}) => Umwelt.type("Track", { slug: Schema.String, ...fields }, key)

describe("chain", () => {
    it("folds to the Model it was made from", () => {
        const chain = chainOf([Track()], [Track({ title: Schema.String })])
        const model = resolveModel([Track({ title: Schema.String })], chain)
        expect(fold(chain).get("Track")).toEqual(model.types.get("Track")?.form)
        expect(changesOf(model.types, chain)).toEqual([])
        expect(model.current).toBe(true)
        expect(chainReasons(chain)).toEqual([])
    })

    it("sorts required, so reordering fields is no change", () => {
        expect(formOf({ title: Schema.String, seconds: Schema.Finite })["required"]).toEqual([
            "seconds",
            "slug",
            "title"
        ])
        const chain = chainOf([Track({ title: Schema.String, seconds: Schema.Finite })])
        expect(resolveModel([Track({ seconds: Schema.Finite, title: Schema.String })], chain).current).toBe(true)
    })

    it("lists Types whose form differs, removed ones included", () => {
        const chain = chainOf([Track(), Umwelt.type("Tag", { name: Schema.String })])
        const model = resolveModel([Track({ title: Schema.String })], chain)
        expect(changesOf(model.types, chain).map(({ type }) => type)).toEqual(["Track", "Tag"])
        expect(model.current).toBe(false)
    })

    it("reports a parent that is not the previous Migration as broken", () => {
        const [first, second] = chainOf([Track()], [Track({ title: Schema.String })])
        if (first === undefined || second === undefined) throw new Error("chain too short")
        const wrongHash = { ...second, parent: { id: first.id, hash: "sha256:0" } }
        expect(chainReasons([first, wrongHash])).toEqual([{ kind: "chainBroken", migration: second.id }])
        expect(chainReasons([second])).toEqual([{ kind: "chainBroken", migration: second.id }])
    })

    it("reports a form before the chain does not fold to as broken", () => {
        const [first, second] = chainOf([Track()], [Track({ title: Schema.String })])
        if (first === undefined || second === undefined) throw new Error("chain too short")
        const stale = { ...second, types: { Track: { before: null, after: second.types["Track"]?.after ?? null } } }
        expect(chainReasons([first, stale])).toEqual([{ kind: "chainBroken", migration: second.id }])
    })

    it("reports two Migrations naming the same parent as fork", () => {
        const base = chainOf([Track()])
        const left = extend(base, [Track({ title: Schema.String })])
        const right = extend(base, [Track({ seconds: Schema.Finite })]).map((migration) => ({
            ...migration,
            id: `${migration.id}-b`
        }))
        const [, ownRight] = right
        if (ownRight === undefined) throw new Error("chain too short")
        expect(chainReasons([...left, ownRight])).toEqual([{ kind: "fork", migration: ownRight.id }])
        expect(ownRight.parent).toEqual({ id: base[0]?.id, hash: migrationHash(base[0] ?? ownRight) })
    })
})

describe("Model checks", () => {
    const reasons = (...types: Parameters<typeof resolveModel>[0]) => declarationReasons(resolveModel(types, []))

    it("passes a valid Model", () => {
        const Play = Umwelt.type("Play", { track: Umwelt.one("Track"), queue: Umwelt.many("Track").sparse() })
        expect(reasons(Track(), Play)).toEqual([])
    })

    it("blocks schemas without JSON form, `Schema.optional`, and `Schema.UndefinedOr`", () => {
        expect(reasons(Umwelt.type("A", { x: Schema.Unknown }))).toEqual([{ kind: "invalidSchema", type: "A" }])
        expect(reasons(Umwelt.type("B", { x: Schema.optional(Schema.String) }))).toEqual([
            { kind: "invalidSchema", type: "B" }
        ])
        expect(reasons(Umwelt.type("C", { x: Schema.Struct({ y: Schema.UndefinedOr(Schema.String) }) }))).toEqual([
            { kind: "invalidSchema", type: "C" }
        ])
    })

    it("blocks a unique key field missing from fields or with another schema", () => {
        const missing = Umwelt.type(
            "A",
            { title: Schema.String },
            { uniqueKey: Schema.Struct({ slug: Schema.String }) }
        )
        const other = Umwelt.type(
            "B",
            { slug: Schema.String },
            // @ts-expect-error key field schema differs from fields
            { uniqueKey: Schema.Struct({ slug: Schema.Finite }) }
        )
        expect(reasons(missing, other)).toEqual([
            { kind: "invalidUniqueKey", type: "A" },
            { kind: "invalidUniqueKey", type: "B" }
        ])
    })

    it("blocks reserved and repeated Type names, and reserved field names", () => {
        const name: string = "query"
        expect(reasons(Umwelt.type(name, {}))).toEqual([{ kind: "reservedTypeName", type: "query" }])
        expect(reasons(Track(), Track())).toEqual([{ kind: "duplicateTypeName", type: "Track" }])
        expect(reasons(Umwelt.type("A", { AND: Schema.String, OR: Schema.String }))).toEqual([
            { kind: "reservedFieldName", type: "A", field: "AND" },
            { kind: "reservedFieldName", type: "A", field: "OR" }
        ])
    })

    it("blocks relations to unknown Types and to Types without unique key, at any depth", () => {
        const Tag = Umwelt.type("Tag", { name: Schema.String })
        const Playlist = Umwelt.type("Playlist", {
            entries: Schema.Array(Schema.Struct({ tag: Umwelt.one("Tag") })),
            lost: Umwelt.many("Nowhere")
        })
        expect(reasons(Tag, Playlist)).toEqual([
            { kind: "relationTargetWithoutUniqueKey", type: "Playlist", field: "entries[].tag", target: "Tag" },
            { kind: "unknownRelationTarget", type: "Playlist", field: "lost", target: "Nowhere" }
        ])
    })

    it("blocks union branches pointing at different Types at one location; null holds no reference", () => {
        const Other = Umwelt.type("Other", { slug: Schema.String }, key)
        const branch = (kind: string, target: string) =>
            Schema.Struct({ kind: Schema.Literal(kind), ref: Umwelt.one(target) })
        const Choice = Umwelt.type("Choice", {
            choice: Schema.Union([branch("a", "Track"), branch("b", "Other")]),
            same: Schema.Union([branch("a", "Track"), branch("b", "Track")]),
            maybe: Schema.NullOr(Umwelt.one("Track"))
        })
        expect(reasons(Track(), Other, Choice)).toEqual([
            { kind: "ambiguousRelation", type: "Choice", field: "choice.ref" }
        ])
        expect(
            resolveModel([Track(), Other, Choice], [])
                .types.get("Choice")
                ?.relations.map(({ target }) => target)
        ).toEqual(["Track", "Other", "Track", "Track"])
    })

    it("blocks union branches putting any value but a reference or null at a relation location", () => {
        const Mixed = Umwelt.type("Mixed", {
            text: Schema.Union([Umwelt.one("Track"), Schema.String]),
            struct: Schema.Union([Umwelt.one("Track"), Schema.Struct({ text: Schema.String })]),
            either: Schema.Union([Umwelt.one("Track"), Umwelt.many("Track")]),
            listOrText: Schema.Union([Umwelt.many("Track"), Schema.String]),
            listOrTexts: Schema.Union([Umwelt.many("Track"), Schema.Array(Schema.String)]),
            nested: Schema.Union([Schema.Struct({ ref: Umwelt.one("Track") }), Schema.Struct({ ref: Schema.Finite })]),
            maybe: Schema.NullOr(Umwelt.many("Track")),
            items: Schema.Array(Schema.NullOr(Umwelt.one("Track")))
        })
        expect(reasons(Track(), Mixed)).toEqual(
            ["text", "struct", "either", "listOrText", "listOrTexts", "nested.ref"].map((field) => ({
                kind: "ambiguousRelation",
                type: "Mixed",
                field
            }))
        )
    })

    it("blocks immutable with history", () => {
        // @ts-expect-error immutable excludes history
        const Log = Umwelt.type("Log", {}, { immutable: true, history: true })
        expect(reasons(Log)).toEqual([{ kind: "immutableWithHistory", type: "Log" }])
    })
})
