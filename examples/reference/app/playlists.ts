/** Playlist keeps history: every change stores the previous full state. */
import { Effect } from "effect"
import { umwelt } from "../umwelt/model"

export const savePlaylist = umwelt.Playlist.write({
    data: { name: "road-trip", tracks: [{ slug: "night-drive" }, { slug: "first-light" }] }
})

export const playlistWithTracks = umwelt.Playlist.query({
    where: { name: "road-trip" },
    include: { tracks: { orderBy: { title: "asc" }, take: 5 } }
})

/** Playlists containing night-drive: `some` with the target's where. */
export const playlistsWith = (slug: string) => umwelt.Playlist.query({ where: { tracks: { some: { slug } } } })

/** Previous states in change order, oldest first, every payload in the current Type schema. */
export const playlistHistory = umwelt.Playlist.history({ object: { name: "road-trip" } })
export const lastChangeAt = Effect.map(playlistHistory, (entries) => entries.at(-1)?.replacedAt)
