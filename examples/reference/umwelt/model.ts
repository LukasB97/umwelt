/** The only hand-written description of the Model: current Types, and the Client made from them. */
import { Schema } from "effect"
import { Umwelt } from "@lukas.b97/umwelt"
import migrations from "./migrations/index.ts"

export const Track = Umwelt.type(
    "Track",
    { slug: Schema.String, title: Schema.String, seconds: Schema.Finite, note: Schema.optionalKey(Schema.String) },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)

/** No unique key: Plays are found by `where` and addressed by Object ID. */
export const Play = Umwelt.type("Play", { track: Umwelt.one("Track"), at: Schema.Date })

export const Playlist = Umwelt.type(
    "Playlist",
    { name: Schema.String, tracks: Umwelt.many("Track") },
    { uniqueKey: Schema.Struct({ name: Schema.String }), history: true }
)

export const umwelt = Umwelt.make([Track, Play, Playlist], { migrations })
