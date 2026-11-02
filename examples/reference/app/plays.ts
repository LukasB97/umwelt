/** Play has no unique key: found by `where`, addressed by Object ID, like documents in a collection. */
import { Effect } from "effect"
import type { ObjectId } from "@lukas.b97/umwelt"
import { type Play, umwelt } from "../umwelt/model"

export type PlayId = ObjectId<typeof Play>

export const logPlay = (at: Date) =>
    Effect.gen(function* () {
        const { id } = yield* umwelt.Play.write({ data: { track: { slug: "night-drive" }, at } })
        yield* umwelt.Play.write({ id, data: { at: new Date(at.getTime() + 60_000) } })
        const play = yield* umwelt.Play.get({ id, include: { track: true } })
        return play?.relations.track?.payload.title
    })

export const playsBetween = (from: Date, to: Date) =>
    umwelt.Play.query({ where: { at: { gt: from, lt: to } }, orderBy: { at: "asc" }, include: { track: true } })

/** Filter through the relation: Identity fields only means the stored reference, other fields read the target. */
export const playsOf = (slug: string) => umwelt.Play.query({ where: { track: { is: { slug } } } })
export const playsOfShort = umwelt.Play.query({ where: { track: { is: { seconds: { lt: 400 } } } } })

export const forget = (ids: readonly [PlayId, ...PlayId[]]) => umwelt.Play.delete({ ids })
