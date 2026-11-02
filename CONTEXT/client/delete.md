# Delete

```ts
type DeleteInput<S extends AnyType | readonly [AnyType, ...AnyType[]]> = {
  /** One Type or non-empty Type list; one selection applies to every selected Type. */
  type: S
} & DeleteSelection<Selected<S>>

/** Type union of S: S itself, or its element Types. */
type Selected<S>

type DeleteSelection<T extends AnyType> =
  /** Selection in Query `where`. Expected current fields protect against stale delete: nothing is deleted when content no longer matches. */
  | { where: Where<T>; ids?: never; allowAll?: never }
  /** Objects by Object ID; unknown IDs match nothing, see Object. */
  | { ids: readonly [ObjectId<T>, ...ObjectId<T>[]]; where?: never; allowAll?: never }
  /** Every Object of selected Types. */
  | { where?: true; ids?: never; allowAll: true }
  /** Selects nothing. */
  | { where: false; ids?: never; allowAll?: never }
```

```ts
type Delete<Ts extends Model> = {
  /**
   * Removes Objects and their history completely; deleted Objects cannot be read or restored.
   * Checks complete selection before change, applies completely or not at all.
   * Relations owns which relations block delete and what stays untouched.
   */
  <S extends Ts[number] | readonly [Ts[number], ...Ts[number][]]>(input: DeleteInput<S>): Effect<DeleteResult<Selected<S>>, DeleteError, SqlClient>
}
```

```ts
/** open: blocked selection as result or as typed error. */
type DeleteResult<T extends AnyType> = {
  matched: ObjectReference<T>[]
  deleted: ObjectReference<T>[]
  /** Objects whose delete strict relations block, with each blocking relation: source Object and its relation field. */
  blocked: { object: ObjectReference<T>; blockedBy: { source: ObjectReference<AnyType>; field: RelationPath }[] }[]
}

/** open: how relation field inside payload is named, like `entries[].track`; same question as include keys. */
type RelationPath = string

type DeleteError =
  | ValidationFailed    // key the input types do not allow
  | ReferencedByHost    // host table references selected Object through immediate foreign key, see Object
  | ModelMismatch       // see Model
```

## Usage

```ts
declare const cutoff: Date
declare const playId: ObjectId<typeof Play>

// selection; nothing is deleted when content no longer matches
umwelt.Play.delete({ where: { at: { lt: cutoff } } })
// by Object ID
umwelt.Play.delete({ ids: [playId] })
// several Types, every Object
umwelt.delete({ type: [Play, Playlist], allowAll: true })
// selects nothing
umwelt.Play.delete({ where: false })

// @ts-expect-error empty where
umwelt.Play.delete({ where: {} })
// @ts-expect-error two selections
umwelt.Play.delete({ where: { at: { lt: cutoff } }, allowAll: true })
```
