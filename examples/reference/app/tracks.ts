/** Track has a unique key: Identity `{ slug }` addresses it. A Type is an Effect Schema. */
import { Effect, Schema } from "effect"
import { Umwelt } from "umwelt-ts"
import { Track, Play, Playlist, umwelt } from "../umwelt/model"

// ---- the Type as schema
export type TrackPayload = typeof Track.Type
export const trackJsonSchema = Schema.toJsonSchemaDocument(Track)
export const Title = Track.fields.title

/** Validate foreign input with the Type itself, then write. */
export const saveFromForm = (formJson: unknown) =>
    Effect.gen(function* () {
        const data = yield* Schema.decodeUnknownEffect(Track)(formJson)
        return yield* umwelt.Track.write({ data })
    })

// ---- write by Identity
export const upsert = umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive", seconds: 420 } })
export const createOnly = umwelt.Track.write({
    data: { slug: "night-drive", title: "Night Drive", seconds: 420 },
    mustNotExist: true
})
export const changeTitle = umwelt.Track.write({
    data: { slug: "night-drive", title: "Night Drive Extended" },
    mustExist: true
})
export const removeNote = umwelt.Track.write({ data: { slug: "night-drive", note: Umwelt.absent } })
export const renameIfUnchanged = umwelt.Track.write({
    data: { slug: "night-drive", title: "Night Drive Extended" },
    mustMatch: { title: "Night Drive" }
})
export const several = umwelt.write([
    { type: Track, data: { slug: "first-light", title: "First Light", seconds: 380 } },
    { type: Playlist, data: { name: "sunday-morning", tracks: [{ slug: "first-light" }] } }
])

// ---- query
export const bySlug = umwelt.Track.query({ where: { slug: "night-drive" } })
export const search = umwelt.Track.query({
    where: { title: { contains: "Night Drive" }, OR: [{ seconds: { lt: 500 } }, { slug: "first-light" }] }
})
export const page = umwelt.Track.query({ orderBy: [{ title: "asc" }, { slug: "desc" }], take: 20, skip: 40 })

/** Relation read backwards: a relation field as value under any key; refinement as for collections. */
export const withRecentPlays = (yesterday: Date) =>
    umwelt.Track.query({
        where: { slug: "night-drive" },
        include: {
            recentPlays: Play.fields.track
                .where({ at: { gt: yesterday } })
                .orderBy({ at: "desc" })
                .take(5),
            playlists: Playlist.fields.tracks
        }
    })

export const lastPlayTime = (yesterday: Date) =>
    Effect.map(withRecentPlays(yesterday), (r) => r.objects[0]?.relations.recentPlays[0]?.payload.at)

// ---- delete
export const deleteDemos = umwelt.Track.delete({ where: { title: { contains: "Demo" } } })
export const wipeAll = umwelt.delete({ type: [Track, Playlist], allowAll: true })
