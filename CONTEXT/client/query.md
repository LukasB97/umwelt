# Query

```ts
type QueryInput<T extends AnyType, I = {}> = {
  type: T
  /** Known Object read by Identity: `where` on Identity fields. */
  where?: Where<T>
  orderBy?: OrderBy<T>
  /** Non-negative integers, here and inside include; TypeScript has no integer type, so Query checks at runtime and fails with ValidationFailed. */
  take?: number
  skip?: number
  cursor?: Cursor<T>
  /** Constrained to Include<T, I> at Query. */
  include?: I
}

/** Filters by payload field values; follows Prisma's `where`, relation filters included. Never empty: at least one condition at every level. Field names `AND`, `OR`, `NOT` are Check's `reservedFieldName`, see Type. */
type Where<T extends AnyType> = AtLeastOne<
  & { [F in keyof Payload<T>]?: F extends RelationSlot<T> ? RelationFilter<T, F> : WhereField<Payload<T>[F]> }
  /** Times Umwelt sets, see Object; like a required Date field. Any other symbol key fails with ValidationFailed. */
  & { [Umwelt.createdAt]?: WhereField<Date>; [Umwelt.changedAt]?: WhereField<Date> }
  & {
      AND?: readonly [Where<T>, ...Where<T>[]]
      OR?: readonly [Where<T>, ...Where<T>[]]
      NOT?: Where<T>
    }
>

/** Scalar field (number, string, boolean, Date, null): bare value or FieldFilter<V>. Object and array fields: FieldFilter<V> only, so `{ equals: value }` stays unambiguous. Optional field also takes `Umwelt.absent`, see Write: Objects without the field. */
type WhereField<V>

/** Filters through the relation with the target's `where`: `is`, `isNot` on `one`; `some`, `every`, `none` on `many`; at least one, nesting at any depth. Naming only Identity fields matches the stored reference itself, without reading the target. */
type RelationFilter<T extends AnyType, S extends RelationSlot<T>>

/** Operators per field type, at least one. open: full operator set, follows Prisma. */
type FieldFilter<V> = AtLeastOne<
  & { equals?: V; in?: readonly V[] }
  & (NonNullable<V> extends number | string | Date ? { lt?: NonNullable<V>; gt?: NonNullable<V> } : {})
  & (NonNullable<V> extends string ? { contains?: string } : {})
>

/**
 * Orders by sortable payload fields and times `Umwelt.createdAt`, `Umwelt.changedAt`. One field per entry, since object keys carry no order; several fields as list, in list order: `[{ title: "asc" }, { slug: "desc" }]`.
 * `null` and absent values sort last for asc and desc.
 * Number fields sort and compare by numeric value, whatever their stored form, like `Infinity` or `NumberFromString`.
 * Without `orderBy`: root Objects and relations read backwards by Object ID, `many` fields in list order; every order ends there, so paging is stable.
 * `many` field holding same target twice yields it once, at first position.
 */
type OrderBy<T extends AnyType> = OrderEntry<T> | readonly [OrderEntry<T>, ...OrderEntry<T>[]]
type OrderEntry<T extends AnyType> = ExactlyOne<{ [F in SortableKeys<Payload<T>> | typeof Umwelt.createdAt | typeof Umwelt.changedAt]: "asc" | "desc" }>

/** Keys of P holding number, string, or Date, also nullable or optional; mixed unions and null-only fields are excluded. */
type SortableKeys<P>

/** Object ID to continue after, exclusive, in the same `orderBy`; unknown ID gives empty result. Inside include, a member of that collection. */
type Cursor<T extends AnyType> = ObjectId<T>

/**
 * Keys that are relation fields of T: `true` returns all related Objects; refinement applies to collections only, `one` field takes `true` or `{ include }`.
 * Every other key takes RelationField of a Model Type pointing at T, see Relations; under that key come the sources pointing at root Object, as collection.
 * Pagination applies per root Object's collection. `include` nests at any depth.
 * open: key for relation field nested inside payload, like `entries[].track`.
 */
type Include<T extends AnyType, I> = {
  [K in keyof I]: K extends OneSlot<T>
    ? true | { include?: Include<Target<T, K>, IncludeOf<I[K]>>; where?: never; orderBy?: never; take?: never; skip?: never; cursor?: never }
    : K extends RelationSlot<T>
      ? true | {
          where?: Where<Target<T, K>>
          orderBy?: OrderBy<Target<T, K>>
          take?: number
          skip?: number
          cursor?: Cursor<Target<T, K>>
          include?: Include<Target<T, K>, IncludeOf<I[K]>>
        }
      : PointingAt<T, I[K]>
}

/** RelationField whose Type is in Ts and whose target is T; its nested include is checked like Include. */
type PointingAt<T extends AnyType, E>
/** Nested include of one include entry, refinement object or RelationField; `true` means none. */
type IncludeOf<E>
/** Type of RelationField E. */
type SourceOf<E>
```

```ts
type Query<Ts extends Model> = {
  /** Selects from current content; history never takes part. */
  <T extends Ts[number], const I extends Include<T, I> = {}>(
    input: QueryInput<T, I>
  ): Effect<QueryResult<T, I>, QueryError, SqlClient>
}
```

```ts
type QueryResult<T extends AnyType, I> = {
  objects: QueryObject<T, I>[]
  /** More Objects follow `take`. */
  pageInfo: { hasMore: boolean }
}

type QueryObject<T extends AnyType, I> = {
  type: TypeName<T>
  /** Object ID, see Object. */
  id: ObjectId<T>
  /** Set by Umwelt, see Object. */
  createdAt: Date
  changedAt: Date
  /** Current payload. */
  payload: Payload<T>
  /**
   * Included Objects sit beside payload, never inside it, and never become stored payload.
   * `one`: target QueryObject, or `null` for sparse reference without existing target.
   * `many` field and RelationField key: array; sparse references without existing target are omitted.
   */
  relations: {
    [K in keyof I]: K extends OneSlot<T>
      ? QueryObject<Target<T, K>, IncludeOf<I[K]>> | null
      : K extends RelationSlot<T>
        ? QueryObject<Target<T, K>, IncludeOf<I[K]>>[]
        : QueryObject<SourceOf<I[K]>, IncludeOf<I[K]>>[]
  }
}

type QueryError =
  | ValidationFailed    // take or skip not a non-negative integer; key the input types do not allow
  | ModelMismatch       // see Model
```

## Usage

```ts
declare const yesterday: Date

// by Identity
umwelt.Track.query({ where: { slug: "night-drive" } })
// optional field missing
umwelt.Track.query({ where: { note: Umwelt.absent } })
// scalar field: bare value or operators; logic by AND, OR, NOT
umwelt.Track.query({ where: { title: { contains: "Night Drive" }, OR: [{ slug: "night-drive" }, { slug: "first-light" }] } })
// relation field: filter through it into the target; Identity fields only means the stored reference
umwelt.Play.query({ where: { track: { is: { title: { contains: "Night Drive" } } } } })
umwelt.Playlist.query({ where: { tracks: { some: { slug: "night-drive" } } } })
// times Umwelt sets: symbol keys, at every level of where and in orderBy
umwelt.Track.query({ where: { [Umwelt.changedAt]: { gt: yesterday } }, orderBy: { [Umwelt.createdAt]: "desc" }, take: 20 })
umwelt.Play.query({ where: { track: { is: { [Umwelt.changedAt]: { gt: yesterday } } } } })
// one field per entry, list order; page by take and skip
umwelt.Track.query({ orderBy: [{ title: "asc" }, { slug: "desc" }], take: 20, skip: 40 })
// `one` slot takes `true`; collection takes refinement
umwelt.Play.query({ include: { track: true } })
umwelt.Playlist.query({ where: { name: "road-trip" }, include: { tracks: { orderBy: { title: "asc" }, take: 5 } } })
// relation read backwards: relation field as value under any key; refinement as for collections
umwelt.Track.query({ where: { slug: "night-drive" }, include: { recentPlays: Play.fields.track.where({ at: { gt: yesterday } }).take(5), playlists: Playlist.fields.tracks } })

// @ts-expect-error empty where
umwelt.Track.query({ where: {} })
// @ts-expect-error `Umwelt.absent` on required field
umwelt.Track.query({ where: { title: Umwelt.absent } })
// @ts-expect-error `some` on `one` field
umwelt.Play.query({ where: { track: { some: { slug: "night-drive" } } } })
// @ts-expect-error time compares with Date
umwelt.Track.query({ where: { [Umwelt.changedAt]: { gt: "yesterday" } } })
// @ts-expect-error `Umwelt.absent` on time
umwelt.Track.query({ where: { [Umwelt.createdAt]: Umwelt.absent } })
// @ts-expect-error time and field in one orderBy entry
umwelt.Track.query({ orderBy: { [Umwelt.createdAt]: "desc", title: "asc" } })
// @ts-expect-error two fields in one orderBy entry
umwelt.Track.query({ orderBy: { title: "asc", slug: "desc" } })
// @ts-expect-error `Play.fields.track` points at Track, not Playlist
umwelt.Playlist.query({ include: { plays: Play.fields.track } })
// @ts-expect-error `true` only for relation field of Track
umwelt.Track.query({ include: { plays: true } })
// @ts-expect-error refinement on `one` slot
umwelt.Play.query({ include: { track: { take: 1 } } })
// @ts-expect-error relation field is not sortable
umwelt.Play.query({ orderBy: { track: "asc" } })
```
