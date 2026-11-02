import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { deploy } from "../examples/reference/deploy.ts"
import * as host from "../examples/reference/app/host.ts"
import * as plays from "../examples/reference/app/plays.ts"
import * as playlists from "../examples/reference/app/playlists.ts"
import * as promised from "../examples/reference/app/promise.ts"
import * as tracks from "../examples/reference/app/tracks.ts"
import { umwelt } from "../examples/reference/umwelt/model.ts"
import { TestDatabase, pgClient, rejection } from "./database.ts"

const at = new Date("2026-10-29T08:00:00.000Z")
const minute = 60_000
const yesterday = new Date(at.getTime() - 24 * 60 * minute)
const user = "0b8f3c2e-6a1d-4f5e-9c7b-2d4e6f8a0b1c"

const slugs = (result: { readonly objects: readonly { readonly payload: { readonly slug: string } }[] }) =>
    result.objects.map((track) => track.payload.slug)

const track = (slug: string) =>
    Effect.flatMap(umwelt.Track.query({ where: { slug } }), ({ objects: [found] }) =>
        found === undefined ? Effect.die(new Error(`no Track ${slug}`)) : Effect.succeed(found)
    )

const reference = (object: { readonly type: string; readonly id: string }) => ({ type: object.type, id: object.id })

describe("reference app", () => {
    layer(TestDatabase("reference"))((it) => {
        it.effect("deploys the reference Model and runs every function of the app, on both faces", () =>
            Effect.gen(function* () {
                yield* deploy
                expect(yield* umwelt.check()).toEqual({ pending: [], blocking: [] })
                const sql = yield* SqlClient.SqlClient
                yield* sql`create table favorite (
                    user_id uuid not null,
                    track_id text not null references ${sql(host.referencedTable)} (id)
                )`

                // tracks: Identity, Write conditions, Query
                expect((yield* tracks.createOnly).outcome).toBe("created")
                expect(yield* Effect.flip(tracks.createOnly)).toMatchObject({ reason: "mustNotExist" })
                expect((yield* tracks.upsert).outcome).toBe("unchanged")
                expect((yield* tracks.renameIfUnchanged).outcome).toBe("changed")
                expect((yield* tracks.changeTitle).outcome).toBe("unchanged")
                expect((yield* tracks.removeNote).outcome).toBe("unchanged")
                const form = { slug: "low-orbit", title: "Low Orbit", seconds: 610 }
                expect((yield* tracks.saveFromForm(form)).outcome).toBe("created")
                expect((yield* tracks.several).map(({ outcome }) => outcome)).toEqual(["created", "created"])
                expect(slugs(yield* tracks.bySlug)).toEqual(["night-drive"])
                expect(slugs(yield* tracks.search)).toEqual(["night-drive"])
                expect(yield* tracks.page).toEqual({ objects: [], pageInfo: { hasMore: false } })
                expect(tracks.trackJsonSchema.schema).toMatchObject({ required: ["slug", "title", "seconds"] })

                // plays: Object ID, Get, Write by id, Delete by ids
                expect(yield* plays.logPlay(at)).toBe("Night Drive Extended")
                const between = yield* plays.playsBetween(yesterday, new Date(at.getTime() + 2 * minute))
                expect(between.objects.map((play) => play.relations.track?.payload.slug)).toEqual(["night-drive"])
                expect((yield* plays.playsOf("night-drive")).objects).toHaveLength(1)
                expect((yield* plays.playsOfShort).objects).toEqual([])

                // playlists: history in change order
                expect((yield* playlists.savePlaylist).outcome).toBe("created")
                const [playlist] = (yield* playlists.playlistWithTracks).objects
                expect(playlist?.relations.tracks.map((listed) => listed.payload.title)).toEqual([
                    "First Light",
                    "Night Drive Extended"
                ])
                const withNightDrive = (yield* playlists.playlistsWith("night-drive")).objects.map(
                    (playlist) => playlist.payload.name
                )
                expect(withNightDrive).toEqual(["road-trip"])
                expect(yield* playlists.playlistHistory).toEqual([])
                yield* umwelt.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } })
                yield* playlists.savePlaylist
                const history = yield* playlists.playlistHistory
                expect(history.map((entry) => entry.payload.tracks.length)).toEqual([2, 1])
                expect(yield* playlists.lastChangeAt).toEqual(history[1]?.replacedAt)

                // relation read backwards
                expect(yield* tracks.lastPlayTime(yesterday)).toEqual(new Date(at.getTime() + minute))
                const [nightDrive] = (yield* tracks.withRecentPlays(yesterday)).objects
                expect(nightDrive?.relations.playlists.map((playlist) => playlist.payload.name)).toEqual(["road-trip"])

                // host foreign keys on Object IDs
                const lowOrbit = yield* track("low-orbit")
                yield* sql`insert into favorite values (${user}, ${lowOrbit.id}), (${user}, ${nightDrive?.id ?? ""})`
                const rows = yield* sql<{ user_id: string; track_id: string }>`select * from favorite`
                const favorites = yield* host.favoriteTracks(rows)
                expect(favorites.map((favorite) => favorite?.payload.slug)).toEqual(["low-orbit", "night-drive"])
                expect(yield* host.favoriteTracks([])).toEqual([])
                const kept = { matched: [reference(lowOrbit)], deleted: [], blocked: [] }
                expect(yield* host.removeTrack("low-orbit")).toEqual(kept)

                // Promise face on a `pg` client, inside and outside the host's transaction
                const pg = yield* pgClient("reference")
                const slowTide = { slug: "slow-tide", title: "Slow Tide", seconds: 500 }
                expect((yield* Effect.promise(() => promised.saveFromForm(pg, slowTide))).outcome).toBe("created")
                const play = yield* Effect.promise(() => promised.favoriteNewPlay(pg, user, at))
                expect((yield* umwelt.Play.get({ id: play }))?.payload.at).toEqual(at)
                const refused = yield* rejection(() => promised.favoriteNewPlay(pg, "nobody", at))
                expect(refused).toMatchObject({ code: "22P02" })
                expect((yield* umwelt.Play.query({})).objects).toHaveLength(2)
                const removed = reference(yield* track("slow-tide"))
                const gone = { matched: [removed], deleted: [removed], blocked: [] }
                expect(yield* Effect.promise(() => promised.removeTrack(pg, "slow-tide"))).toEqual(gone)
                expect(yield* Effect.promise(() => promised.removeTrack(pg, "low-orbit"))).toEqual(kept)

                // deletes
                expect(yield* tracks.deleteDemos).toEqual({ matched: [], deleted: [], blocked: [] })
                const [first, ...rest] = (yield* umwelt.Play.query({})).objects.map(({ id }) => id)
                if (first === undefined) return yield* Effect.die(new Error("no Plays"))
                expect((yield* plays.forget([first, ...rest])).deleted).toHaveLength(2)
                yield* sql`delete from favorite`
                const wiped = yield* tracks.wipeAll
                expect(wiped.deleted).toHaveLength(wiped.matched.length)
                expect(wiped.matched.length).toBeGreaterThan(0)
                expect(yield* tracks.bySlug).toEqual({ objects: [], pageInfo: { hasMore: false } })
            })
        )
    })
})
