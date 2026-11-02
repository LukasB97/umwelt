/**
 * Host tables reference Umwelt Objects by Object ID. The host owns this SQL:
 *
 *   CREATE TABLE favorite (
 *     user_id uuid NOT NULL,
 *     track_id text NOT NULL REFERENCES umwelt_object(id)   -- immediate, no cascade: Delete reports it as ReferencedByHost
 *   );
 */
import { Effect, Schema } from "effect"
import { Umwelt, type DeleteResult } from "@lukas.b97/umwelt"
import { Track, umwelt } from "../umwelt/model"

export const referencedTable = Umwelt.objectTable.name

type FavoriteRow = { user_id: string; track_id: string }

/** Column values become ObjectIds through the Type's codec, then one Get resolves them all, in input order. */
export const favoriteTracks = (rows: readonly FavoriteRow[]) =>
    Effect.gen(function* () {
        const ids = yield* Effect.forEach(rows, (row) => Schema.decodeEffect(Track.ObjectId)(row.track_id))
        const [first, ...rest] = ids
        if (first === undefined) return []
        return yield* umwelt.Track.get({ ids: [first, ...rest] })
    })

/** A Track some host row still points at stays: matched, not deleted. The host decides what to do. */
export const removeTrack = (slug: string) =>
    umwelt.Track.delete({ where: { slug } }).pipe(
        Effect.catchTag("ReferencedByHost", () =>
            Effect.map(umwelt.Track.query({ where: { slug } }), ({ objects }): DeleteResult<typeof Track> => ({
                matched: objects.map(({ type, id }) => ({ type, id })),
                deleted: [],
                blocked: []
            }))
        )
    )
