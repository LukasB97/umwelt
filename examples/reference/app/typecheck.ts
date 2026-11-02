/** Not application code: proves what the types in this reference reject and infer. One line per rule. */
import { type Effect, Schema } from "effect"
import {
    Umwelt,
    type Change,
    type DeleteResult,
    type ObjectId,
    type OrderEntry,
    type Promised,
    type QueryObject,
    type SortableKeys,
    type WriteResult
} from "@lukas.b97/umwelt"
import { Track, Play, type Playlist, umwelt } from "../umwelt/model"
import { type bySlug, type lastPlayTime, type withRecentPlays } from "./tracks"
import { type logPlay, type PlayId } from "./plays"
import { type playlistHistory } from "./playlists"
import { type favoriteTracks, type removeTrack } from "./host"

declare const playId: PlayId
declare const trackId: ObjectId<typeof Track>
declare const yesterday: Date

// ---------------------------------------------------------------- inferred shapes, exact
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Success<E> = E extends Effect.Effect<infer A, unknown, unknown> ? A : never

const _payload: Equal<
    typeof Track.Type,
    { readonly slug: string; readonly title: string; readonly seconds: number; readonly note?: string }
> = true
const _decoded: Equal<
    Success<ReturnType<ReturnType<typeof Schema.decodeUnknownEffect<typeof Track>>>>,
    typeof Track.Type
> = true
const _lastPlay: Equal<Success<ReturnType<typeof lastPlayTime>>, Date | undefined> = true
const _logPlay: Equal<Success<ReturnType<typeof logPlay>>, string | undefined> = true
const _history: Equal<
    Success<typeof playlistHistory>[number]["payload"]["tracks"],
    readonly { readonly slug: string }[]
> = true
const _favorites: Equal<
    Success<ReturnType<typeof favoriteTracks>>,
    (QueryObject<readonly [typeof Track, typeof Play, typeof Playlist], typeof Track, {}> | null)[]
> = true
const _pageInfo: Equal<Success<typeof bySlug>["pageInfo"], { hasMore: boolean }> = true
const _removed: Equal<Success<ReturnType<typeof removeTrack>>, DeleteResult<typeof Track>> = true
const _sortable: Equal<
    SortableKeys<{ a: number | null; b?: Date; c: "x" | "y"; d: string | number; e: null; f: boolean }>,
    "a" | "b" | "c"
> = true
type Relations = Success<ReturnType<typeof withRecentPlays>>["objects"][number]["relations"]
const _relationKeys: Equal<keyof Relations, "recentPlays" | "playlists"> = true
const _recentPlayType: Equal<Relations["recentPlays"][number]["type"], "Play"> = true
const _playlistName: Equal<Relations["playlists"][number]["payload"]["name"], string> = true
const _createdAt: Equal<NonNullable<Success<ReturnType<typeof favoriteTracks>>[number]>["createdAt"], Date> = true
const _changedAt: Equal<Relations["recentPlays"][number]["changedAt"], Date> = true

// Promise face: same inputs, Promise results, overloads kept
declare const pg: { query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: readonly unknown[] }> }
const database = umwelt.promise(pg)
const _pWriteCall = database.Track.write({ data: { slug: "a", title: "A", seconds: 1 } })
const _pWrite: Equal<typeof _pWriteCall, Promise<WriteResult<typeof Track>>> = true
const _pList = database.write([{ type: Track, data: { slug: "a", title: "A", seconds: 1 } }])
const _pListType: Equal<typeof _pList, Promise<WriteResult<typeof Track | typeof Play | typeof Playlist>[]>> = true
const _pGetOne = database.Play.get({ id: playId })
const _pGetOneType: Equal<
    typeof _pGetOne,
    Promise<QueryObject<readonly [typeof Track, typeof Play, typeof Playlist], typeof Play, {}> | null>
> = true
const _pGetMany = database.Play.get({ ids: [playId] })
const _pGetManyType: Equal<
    typeof _pGetMany,
    Promise<(QueryObject<readonly [typeof Track, typeof Play, typeof Playlist], typeof Play, {}> | null)[]>
> = true
const _pCheck: Equal<ReturnType<typeof database.check>, Promise<Change>> = true
const _promised: Equal<Promised<typeof umwelt>, typeof database> = true
const _run = umwelt.promise((sql, parameters) => Promise.resolve([sql, ...parameters]))

// ---------------------------------------------------------------- rejected by the types
// @ts-expect-error Play ID for Track
umwelt.Track.get({ id: playId })
// @ts-expect-error empty ids
umwelt.Play.get({ ids: [] })
// @ts-expect-error Play keeps no history
umwelt.Play.history({ object: playId })
// @ts-expect-error Play keeps no history on the Promise face either
database.Play.history({ object: playId })
// @ts-expect-error no Promise face on the Promise face
database.promise(pg)
// @ts-expect-error create-only needs complete data
umwelt.Track.write({ data: { slug: "night-drive" }, mustNotExist: true })
// @ts-expect-error two conditions
umwelt.Track.write({ data: { slug: "night-drive" }, mustExist: true, mustNotExist: true })
// @ts-expect-error `id` beside Identity
umwelt.Track.write({ data: { slug: "night-drive" }, id: trackId })
// @ts-expect-error `Umwelt.absent` on required field
umwelt.Track.write({ data: { slug: "night-drive", title: Umwelt.absent } })
// @ts-expect-error Play data under Track type
umwelt.write({ type: Track, data: { track: { slug: "night-drive" }, at: yesterday } })
// @ts-expect-error create without unique key needs complete data
umwelt.Play.write({ data: { at: yesterday } })
// @ts-expect-error empty where
umwelt.Track.query({ where: {} })
// @ts-expect-error `some` on `one` field
umwelt.Play.query({ where: { track: { some: { slug: "night-drive" } } } })
// @ts-expect-error `is` on `many` field
umwelt.Playlist.query({ where: { tracks: { is: { slug: "night-drive" } } } })
// @ts-expect-error unknown field of the target
umwelt.Playlist.query({ where: { tracks: { some: { nope: 1 } } } })
// @ts-expect-error one field per orderBy entry; several fields as list
umwelt.Track.query({ orderBy: { title: "asc", slug: "desc" } })
// @ts-expect-error relation field is not sortable
umwelt.Play.query({ orderBy: { track: "asc" } })
// @ts-expect-error mixed union is not sortable
const _mixed: OrderEntry<{ n: string | number }> = { n: "asc" }
// @ts-expect-error null-only field is not sortable
const _nothing: OrderEntry<{ n: null }> = { n: "asc" }
// @ts-expect-error cursor is an Object ID of the queried Type
umwelt.Track.query({ cursor: playId })
// @ts-expect-error cursor inside include is an Object ID of the collection's Type
umwelt.Playlist.query({ include: { tracks: { cursor: playId } } })
// @ts-expect-error cursor of a relation field is an Object ID of its Type
Play.fields.track.cursor(trackId)
// @ts-expect-error refinement on `one` slot
umwelt.Play.query({ include: { track: { take: 1 } } })
// @ts-expect-error `Play.fields.track` points at Track, not Playlist
umwelt.Playlist.query({ include: { plays: Play.fields.track } })
// @ts-expect-error `true` only for relation fields of Track
umwelt.Track.query({ include: { plays: true } })
// @ts-expect-error where on the edge knows Play's fields
Play.fields.track.where({ title: "x" })
// @ts-expect-error scalar field is no edge
Track.fields.slug.where
// @ts-expect-error reserved Type name
Umwelt.type("write", { x: Schema.String })
// @ts-expect-error immutable with history
Umwelt.type("Frozen", { x: Schema.String }, { immutable: true, history: true })
// @ts-expect-error unique key field with another schema than the field; a key naming an unknown field is Check's `invalidUniqueKey`
Umwelt.type("Odd", { x: Schema.String }, { uniqueKey: Schema.Struct({ x: Schema.Finite }) })
Umwelt.step({
    before: { type: "object", properties: { duration: { type: "number" } }, required: ["duration"] },
    after: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
    // @ts-expect-error migrate sees the form before: no `seconds` yet
    migrate: (old) => ({ seconds: old.seconds })
})
Umwelt.step({
    before: { type: "object", properties: { duration: { type: "number" } }, required: ["duration"] },
    after: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
    // @ts-expect-error result must fit the form after
    migrate: (old) => ({ duration: old.duration })
})
