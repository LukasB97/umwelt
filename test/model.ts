/** Test Model: unique key, nullable optional field, sparse `one`, strict `many`, relation nested in a list. */
import { Schema } from "effect"
import type { Reference } from "../src/declaration.ts"
import { Umwelt } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"

export const Track = Umwelt.type(
    "Track",
    {
        slug: Schema.String,
        title: Schema.String,
        seconds: Schema.Finite,
        note: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)

export const Play = Umwelt.type("Play", {
    source: Schema.String,
    track: Umwelt.one("Track").sparse(),
    at: Schema.Date
})

export const Playlist = Umwelt.type(
    "Playlist",
    {
        name: Schema.String,
        tracks: Umwelt.many("Track"),
        tags: Schema.Array(Schema.String),
        entries: Schema.optionalKey(Schema.Array(Schema.Struct({ track: Umwelt.one("Track"), rating: Schema.Finite })))
    },
    { uniqueKey: Schema.Struct({ name: Schema.String }), history: true }
)

/** Recursive schema part holding a relation: Check's `recursiveRelation`. */
interface Part {
    readonly track: Reference<"Track">
    readonly parts: readonly Part[]
}
export const Part = Schema.Struct({
    track: Umwelt.one("Track"),
    parts: Schema.Array(Schema.suspend((): Schema.Codec<Part> => Part))
})

/** Part again, under a definition name its `$ref` escapes: `#/$defs/Part~1of~0a%20tree%20%25`. */
export const EscapedPart: Schema.Codec<Part> = Schema.Struct({
    track: Umwelt.one("Track"),
    parts: Schema.Array(Schema.suspend((): Schema.Codec<Part> => EscapedPart))
}).annotate({ identifier: "Part/of~a tree %" })

export const model = resolveModel([Track, Play, Playlist], [])

export const resolved = (name: string) => {
    const type = model.types.get(name)
    if (type === undefined) throw new Error(`no Type ${name}`)
    return type
}
