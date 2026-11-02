---
order: 10
render_to: CONTEXT/client/write.md
read_when: "writing Objects: upsert, conditions, overlay, entry lists."
---
# Write

```ts
/** Address follows unique key. Distributes over T: list mixing Types pairs each `type` with its own entry shape. */
type WriteEntry<T extends AnyType> = T extends AnyType
  ? { type: T } & (HasUniqueKey<T> extends true ? IdentityEntry<T> : IdEntry<T>)
  : never

/** Identity inside `data` addresses the Object. One condition at most; `data` shape follows the condition. Conditions never change Identity or overlay. */
type IdentityEntry<T extends AnyType> =
  /** Upsert: creates when no Object exists for Identity, else overlays. */
  | { data: ChangeInput<T>; mustExist?: never; mustNotExist?: never; mustMatch?: never }
  /** Rejects when Object exists; `data` is complete state. */
  | { data: Payload<T>; mustNotExist: true; mustExist?: never; mustMatch?: never }
  /** Rejects when no Object exists for Identity. */
  | { data: ChangeInput<T>; mustExist: true; mustNotExist?: never; mustMatch?: never }
  /**
   * Expected current fields. Rejects when Object is missing or any supplied field differs.
   * Fields not given are unconstrained; `Umwelt.absent` means field must be missing. Comparison ignores JSON object key order.
   * Conflict check at Write time; no lease or client-side lock.
   */
  | { data: ChangeInput<T>; mustMatch: MatchInput<T>; mustExist?: never; mustNotExist?: never }

/** No Identity: `id` beside `data` addresses the Object; without `id`, Write creates. */
type IdEntry<T extends AnyType> =
  /** Creates; `data` is complete state. */
  | { data: Payload<T>; id?: never; mustMatch?: never }
  /** Overlays Object `id` names; rejects when none exists. `mustMatch` as above. */
  | { id: ObjectId<T>; data: Overlay<Payload<T>>; mustMatch?: MatchInput<T> }

/**
 * Identity required; other fields overlay current payload, top-level field by field:
 * field with value sets it, nested objects and arrays replace completely;
 * field with `Umwelt.absent` removes it, allowed on optional schema fields only; field not given keeps current value.
 * Complete resulting state must fit Type schema.
 */
type ChangeInput<T extends AnyType> = Identity<T> & Overlay<Omit<Payload<T>, keyof Identity<T>>>

type MatchInput<T extends AnyType> = AtLeastOne<Overlay<Payload<T>>>

type Overlay<P> =
  & { [K in RequiredKeys<P>]?: P[K] }
  & { [K in OptionalKeys<P>]?: P[K] | Absent }

namespace Umwelt {
  /** Marks a field absent: removes it in `data`, requires it missing in `mustMatch`, finds Objects without it in Query `where`. A symbol: never JSON, never stored. */
  const absent: unique symbol
}
type Absent = typeof Umwelt.absent
```

```ts
type Write<Ts extends Model> = {
  /**
   * Address is Identity in `data` or `id` beside it, never both.
   * Equal content returns `unchanged`. Immutable Types: Type owns what Write may change.
   * Relation fields are normal payload fields; Relations owns when targets must exist.
   */
  <T extends Ts[number]>(entry: WriteEntry<T>): Effect<WriteResult<T>, WriteError, SqlClient>
  /**
   * Ordered list, may mix Types. Entries apply in order, each seeing earlier entries; all commit or none.
   * Same Identity twice is rejected. Results in input order.
   */
  (entries: readonly WriteEntry<Ts[number]>[]): Effect<WriteResult<Ts[number]>[], WriteError, SqlClient>
}
```

```ts
type WriteResult<T extends AnyType> = {
  id: ObjectId<T>
  outcome: "created" | "changed" | "unchanged"
}

/** Failure kinds. Condition rejection is own error, distinct from validation failure. */
type WriteError =
  | ConditionRejected   // mustExist, mustNotExist, mustMatch, immutable change, unknown `id`, see Object
  | DuplicateIdentity   // same Identity twice in one list; value fact, type cannot exclude it
  | ValidationFailed    // resulting state fails Type schema: incomplete create through upsert, overlay result, schema check; or key or `absent` the input types do not allow
  | MissingTarget       // strict relation target missing after list applied
  | ModelMismatch       // see Model
```

## Usage

```ts
declare const playId: ObjectId<typeof Play>
declare const trackId: ObjectId<typeof Track>
declare const earlier: Date, later: Date

// upsert by Identity: creates, else overlays
umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive" } })
// create only
umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive" }, mustNotExist: true })
// change only; `title` not given keeps, `Umwelt.absent` removes optional `note`
umwelt.Track.write({ data: { slug: "night-drive", note: Umwelt.absent }, mustExist: true })
// change only when current content matches
umwelt.Track.write({ data: { slug: "night-drive", title: "Night Drive Remix" }, mustMatch: { title: "Night Drive" } })
// without unique key: no `id` creates
umwelt.Play.write({ data: { track: { slug: "night-drive" }, at: earlier } })
// without unique key: `id` addresses, mustMatch guards that Object
umwelt.Play.write({ id: playId, data: { at: later } })
umwelt.Play.write({ id: playId, data: { at: later }, mustMatch: { at: earlier } })
// relation field holds target Identity
umwelt.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } })
// ordered list mixing Types, all or none; later entries see earlier ones
umwelt.write([
  { type: Track, data: { slug: "night-drive", title: "Night Drive" } },
  { type: Play, data: { track: { slug: "night-drive" }, at: earlier } },
])

// @ts-expect-error two conditions
umwelt.Track.write({ data: { slug: "night-drive" }, mustExist: true, mustNotExist: true })
// @ts-expect-error `id` beside Identity
umwelt.Track.write({ id: trackId, data: { slug: "night-drive", title: "Night Drive" } })
// @ts-expect-error `Umwelt.absent` on required field
umwelt.Track.write({ data: { slug: "night-drive", title: Umwelt.absent }, mustExist: true })
// @ts-expect-error Play `data` under Track `type`
umwelt.write([{ type: Track, data: { track: { slug: "night-drive" }, at: earlier } }])
```
