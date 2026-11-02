# Relations

Relations are declared inside Type schema at payload fields; target names Type by name string, so Types reference each other without import order problems.
Target must be Type of the Model with unique key: [Check](client/check.md) blocks unknown name with `unknownRelationTarget`, Type without unique key with `relationTargetWithoutUniqueKey`.
One payload location holds references to one target Type, or `null`; union branches putting another Type or any other value there are blocked with `ambiguousRelation`.
Relation fields inside recursive schema parts are blocked with `recursiveRelation`; later, not now.

```ts
const Play = Umwelt.type("Play", {
  track: Umwelt.one("Track"),
  queue: Umwelt.many("Track").sparse(),
})
```

- `Umwelt.one("Type")` holds target [Identity](object.md); inside `Schema.NullOr`, `null` holds no reference and reads as `null`, or empty list for `many`.
- `Umwelt.many("Type")` holds list of target Identities.
- No modifier means strict; `.sparse()` means sparse.

```ts
namespace Umwelt {
  /** Field holding Identity of one target. */
  function one<const N extends string>(target: N): Relation<N, "one", "strict">
  /** Field holding list of target Identities. */
  function many<const N extends string>(target: N): Relation<N, "many", "strict">
}

/**
 * Effect Schema usable at any depth inside `fields`. `Type` side is placeholder `Reference<N>`, or `readonly Reference<N>[]` for `many`, resolved in Client.
 * Carries annotation `x-umwelt-relation` with target, cardinality, and mode; exported with `includeAnnotationKey`, so Umwelt finds relations in the JSON Schema, not in Effect's AST.
 */
type Relation<N extends string, Card extends "one" | "many", Mode extends "strict" | "sparse"> = Schema.Codec<Card extends "one" ? Reference<N> : readonly Reference<N>[]> & {
  sparse(): Relation<N, Card, "sparse">
}

/**
 * Relation field as value, under `fields` of its Type: `Play.fields.track`. Under any key of include on target Type it reads the sources pointing there, see Query.
 * Refinement as for collections in Query.
 */
type RelationField<S extends AnyType, K extends RelationSlot<S>, I = {}> = {
  where(where: Where<S>): RelationField<S, K, I>
  orderBy(orderBy: OrderBy<S>): RelationField<S, K, I>
  take(n: number): RelationField<S, K, I>
  skip(n: number): RelationField<S, K, I>
  cursor(cursor: Cursor<S>): RelationField<S, K, I>
  include<const J>(include: J): RelationField<S, K, J>
}
```

Relation fields may sit at any depth, inside nested structures and arrays.
Target may be same or other Type; self and mutual relations are valid.

Source payload field owns relation truth; Umwelt never changes source field as relation side effect.
Relations point at Objects, never at past states.

## Resolution

Strict relation:

- Target Object must exist when source is written.
- Deleting target is blocked while source points at it.

Sparse relation allows missing target:

- Source may be written before target exists.
- Target may be deleted; source reference stays unchanged.
- Reference resolves only while target exists.

Umwelt has no cascade: deleting target never deletes source and never clears source fields.
Checks apply to complete Write list or Delete selection, so Objects referencing each other are written together in one list and deleted together in one selection, by `ids` or `allowAll` when they differ in Type.

## Reading

`one` field resolves to at most one Object; `many` field resolves to collection.
Finding through relations is [Query](client/query.md)'s `where`: it filters into the target's fields.
Relation reads backwards without declaration: relation field is value on its Type, `Play.fields.track`, and under any key of include on Track it yields the Plays pointing there, as collection.
Nothing is stored for it, and reader names it per call; `const plays = Play.fields.track` exported is the declaration for who wants one.
Query owns include.
