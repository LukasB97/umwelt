# Get

```ts
type GetOne<T extends AnyType, I = {}> = {
  type: T
  id: ObjectId<T>
  /** As in Query, constrained to Include<T, I> at Get. */
  include?: I
}

type GetMany<T extends AnyType, I = {}> = {
  type: T
  ids: readonly [ObjectId<T>, ...ObjectId<T>[]]
  include?: I
}
```

```ts
type Get<Ts extends Model> = {
  /** One Object by Object ID from current content; `null` when unknown, see Object. */
  <T extends Ts[number], const I extends Include<T, I> = {}>(input: GetOne<T, I>): Effect<QueryObject<T, I> | null, GetError, SqlClient>
  /** Objects in input order, `null` where unknown. Host resolves its foreign keys here, see Object. */
  <T extends Ts[number], const I extends Include<T, I> = {}>(input: GetMany<T, I>): Effect<(QueryObject<T, I> | null)[], GetError, SqlClient>
}
```

```ts
type GetError =
  | ValidationFailed    // `take` or `skip` inside include not a non-negative integer; key the input types do not allow
  | ModelMismatch       // see Model
```

## Usage

```ts
declare const playId: ObjectId<typeof Play>
declare const playIds: readonly [ObjectId<typeof Play>, ...ObjectId<typeof Play>[]]

// one Object or null
umwelt.Play.get({ id: playId })
// include as in Query
umwelt.Play.get({ id: playId, include: { track: true } })
// list, in input order
umwelt.Play.get({ ids: playIds })

// @ts-expect-error Play ID for Track
umwelt.Track.get({ id: playId })
// @ts-expect-error empty ids
umwelt.Play.get({ ids: [] })
```
