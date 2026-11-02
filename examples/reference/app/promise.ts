/**
 * Host without Effect: same Client, Promise face. Types stay Effect Schema, a library import; nothing of Effect runs here.
 * The executor is whatever runs SQL: a `pg` pool, client, or transaction.
 */
import { Schema } from "effect"
import { ReferencedByHost, type DeleteResult } from "@lukas.b97/umwelt"
import { Track, umwelt } from "../umwelt/model"

/** Shape of a `pg` client, declared here so the reference needs no dependency. */
type PgClient = { query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: readonly unknown[] }> }

/** Validate with the Type itself, synchronously, then write. */
export const saveFromForm = async (pg: PgClient, formJson: unknown) => {
    const data = Schema.decodeUnknownSync(Track)(formJson)
    return umwelt.promise(pg).Track.write({ data })
}

/** Inside the host's own transaction: Umwelt runs on the same client, so it commits or rolls back with the host. */
export const favoriteNewPlay = async (pg: PgClient, userId: string, at: Date) => {
    await pg.query("begin")
    try {
        const database = umwelt.promise(pg)
        const { id } = await database.Play.write({ data: { track: { slug: "night-drive" }, at } })
        const [track] = await database.Track.query({ where: { slug: "night-drive" } }).then((r) => r.objects)
        if (track !== undefined)
            await pg.query("insert into favorite (user_id, track_id) values ($1, $2)", [userId, track.id])
        await pg.query("commit")
        return id
    } catch (error) {
        await pg.query("rollback")
        throw error
    }
}

/** Failures are the same classes as on the Effect face, thrown. A Track a host row points at stays: matched, not deleted. */
export const removeTrack = async (pg: PgClient, slug: string): Promise<DeleteResult<typeof Track>> => {
    const database = umwelt.promise(pg)
    try {
        return await database.Track.delete({ where: { slug } })
    } catch (error) {
        if (!(error instanceof ReferencedByHost)) throw error
        const { objects } = await database.Track.query({ where: { slug } })
        return { matched: objects.map(({ type, id }) => ({ type, id })), deleted: [], blocked: [] }
    }
}
