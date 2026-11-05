# Type

Type declares what content means; every Object has one Type and follows it.
Developers define Types in code, like track, play, or playlist.
Minimal Type has name and schema. Optional parts: unique key, `unique`, [relations](relations.md), `immutable`, `history`.
Types belong to [Model](model.md); application code never creates or changes Types at runtime.

```ts
type Fields = Schema.Struct.Fields

/** Type names must not collide with Client operations; the guard below catches literal names, Check reports `reservedTypeName` for every name. */
type ReservedTypeName = "write" | "get" | "query" | "delete" | "history" | "check" | "deploy" | "promise"

type Mutability =
  /** `history` keeps previous full state on every change. */
  | { immutable?: false; history?: boolean }
  /** Immutable Objects never change, so `history` is excluded. */
  | { immutable: true; history?: never }

/** Fields of F, same schemas. */
type SubFields<F extends Fields> = { [K in keyof F]?: F[K] }

/** One unique constraint over F: `true` leaves name the values unique together; `UniquePath` on `one` relation fields only, `many` relation fields excluded. */
type Unique<F extends Fields> = AtLeastOne<{ [K in keyof F]?: true | UniquePath }>
/** Path into stored reference of `one` relation field. */
type UniquePath = { [key: string]: true | UniquePath }
```

```ts
namespace Umwelt {
  /** Declares Type from Effect fields. Relation fields come from Relations. */
  function type<const N extends string, const F extends Fields, const UK extends SubFields<F> & Fields = {}, const M extends Mutability = {}>(
    name: N extends ReservedTypeName ? never : N,
    fields: F,
    /**
     * `uniqueKey`: fields forming Identity, see Object. The type rejects a key field whose schema differs from `fields`; a key field missing from `fields` is Check's `invalidUniqueKey`.
     * `unique`: constraints beside Identity, see Unique. The type rejects unknown fields, `many` relation fields, and paths below other fields; a path leaving target's unique key is Check's `invalidUnique`.
     */
    options?: { uniqueKey?: Schema.Struct<UK>; unique?: readonly Unique<F>[] } & M
  ): Type<N, F, UK, M>
}
```

```ts
/**
 * Type is Effect Schema of its payload, `Schema.Struct(fields)`, plus name and Object ID codec.
 * Application code uses it like any schema: `typeof Track.Type`, `Schema.decodeUnknownEffect(Track)`, `Track.fields.title`, `Schema.toJsonSchemaDocument(Track)`.
 * Client derives TypeName, Payload, Identity, and HistoryType from it, see Client.
 */
type Type<N extends string, F extends Fields, UK extends Fields, M extends Mutability> = Schema.Struct<F> & {
  readonly name: N
  /** Decodes stored string to ObjectId of this Type, for host columns, see Object. */
  readonly ObjectId: Schema.Codec<ObjectId<Type<N, F, UK, M>>, string>
  /** Effect's fields. Exported type makes every relation field also RelationField of this Type, see Relations: `Play.fields.track`. */
  readonly fields: F
}
```

## Schema

Schema is Effect Schema of payload; nested structures, arrays, unions, and recursive shapes are allowed.

Payload is schema's `Type` side, like `Date`.
Stored content is encoded side of `Schema.toCodecJson(schema)`, JSON; `Schema.toJsonSchemaDocument` with `includeAnnotationKey` describes it, and that form lives in [Migrations](model.md).
Schema is invalid, and [Check](client/check.md) blocks it with `invalidSchema`, when it has no JSON codec, exports as opaque `{}`, or uses `Schema.optional` or `Schema.UndefinedOr`.
Field names `AND`, `OR`, `NOT` belong to [Query](client/query.md); Check blocks them with `reservedFieldName` in every struct a where reads, at their path like `steps[].AND`.
Optional field is `Schema.optionalKey`: key absent, since JSON has no `undefined`; [Write](client/write.md) owns removing fields.
Schema checks like `Schema.isGreaterThan(0)` are part of schema; TypeScript cannot express them, [Client](client.md) owns where they are checked.

Later, not now: declaring Types from JSON Schema. Migrations already hold JSON Schema, so that entrance changes no storage.

## Unique Key

Unique key selects schema fields forming [Identity](object.md): one or several fields, each present in `fields` with same schema, else [Check](client/check.md) blocks with `invalidUniqueKey`.
Without unique key, Objects have no Identity, see Object.
Identity never changes ([Object](object.md)), so Check blocks unique key change with `uniqueKeyChangeWithObjects` while Objects of Type exist: delete them first.

## Unique

`unique` lists constraints independent of Identity: no two Objects of Type hold equal values in all fields of one constraint. Values may change; Type may have many constraints; key order never counts.

```ts
const Issue = Umwelt.type("Issue", { key: Schema.String, slug: Schema.String, status: Umwelt.one("Status"), number: Schema.Int }, {
  uniqueKey: Schema.Struct({ key: Schema.String }),
  unique: [{ status: { team: true }, number: true }, { slug: true }],   // number per team of status; slug
})
```

`field: true` takes whole value, compared as JSON, object key order aside; on `one` relation field, whole stored reference, target Identity.
Nested object on `one` relation field is path into stored reference; it reaches only fields of target's unique key, which sit in this Object's payload and never change. Check blocks other paths, `many` relation fields, and unknown fields with `invalidUnique`.
JSON null or absent value in any field of constraint never collides, like SQL NULL.
Database enforces each constraint, also against concurrent Writes: [Write](client/write.md) fails with `UniqueViolation`; [Deploy](client/deploy.md) adds, changes, and drops constraints.

## Mutability

Types are mutable by default: Write may change existing Object.
`immutable` means Objects are written once and never changed.
Write with differing content for existing immutable Object is rejected; equal content returns `unchanged`.
New content is new Object: under another Identity with unique key, under new Object ID without. `immutable` constrains Write only; [Migrations](model.md) transform immutable Objects too.
Immutable Type fits content other content relies on as written: correction becomes new Object, and references keep pointing at the old one.

## History

`history` stores previous full state of Object on every change; default off.
[History](client/history.md) owns reading it.
`immutable` with `history` is invalid: immutable Objects never change.
