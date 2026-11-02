# History

```ts
type HistoryInput<T extends HistoryType> = {
  type: T
  /** One Object, by Object ID or Identity. */
  object: ObjectId<T> | Identity<T>
}
```

```ts
type History<Ts extends Model> = {
  /**
   * Previous full states of one Object, in change order; unknown Object gives empty list.
   * Read-only; restoring old state is normal Write. Get, Query, and include never read history; nothing references it.
   * open: pagination.
   */
  <T extends Ts[number] & HistoryType>(input: HistoryInput<T>): Effect<HistoryEntry<T>[], HistoryError, SqlClient>
}
```

```ts
type HistoryEntry<T extends HistoryType> = {
  /** Previous full state in current Type schema; Deploy owns why. */
  payload: Payload<T>
  /** Time this state was replaced. */
  replacedAt: Date
}

type HistoryError =
  | ValidationFailed    // key the input types do not allow
  | ModelMismatch       // see Model
```

## Usage

```ts
declare const playlistId: ObjectId<typeof Playlist>

// by Identity
umwelt.Playlist.history({ object: { name: "road-trip" } })
// by Object ID
umwelt.Playlist.history({ object: playlistId })

// @ts-expect-error Track has no `history`
umwelt.Track.history({ object: { slug: "night-drive" } })
```
