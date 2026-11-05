# Client

Client is model-aware API made from Model; every operation on Objects and Model goes through it.

```ts
const Track = Umwelt.type("Track", { slug: Schema.String, title: Schema.String, note: Schema.optionalKey(Schema.String), release: Schema.optionalKey(Schema.Struct({ label: Schema.String, genres: Schema.Array(Schema.String), credits: Schema.Array(Schema.Struct({ role: Schema.String, name: Schema.String })) })) }, { uniqueKey: Schema.Struct({ slug: Schema.String }) })
const Play = Umwelt.type("Play", { track: Umwelt.one("Track"), at: Schema.Date }, { unique: [{ track: true, at: true }] })
const Playlist = Umwelt.type("Playlist", { name: Schema.String, tracks: Umwelt.many("Track") }, { uniqueKey: Schema.Struct({ name: Schema.String }), history: true })
const umwelt = Umwelt.make([Track, Play, Playlist], { migrations })   // migrations: the chain, see Model
```

Client gives application code Type names, payload fields, relation fields, Write Input, and result shapes with type checking.

```ts
namespace Umwelt {
  /** Never fails; Model errors are Check's. `migrations` is the chain in order, see Model. */
  function make<const Ts extends Model>(types: Ts, options: { migrations: readonly Migration[] }): Client<Ts>
}

type Client<Ts extends Model> = {
  write: Write<Ts>
  get: Get<Ts>
  query: Query<Ts>
  delete: Delete<Ts>
  history: History<Ts>
  check: Check
  deploy: Deploy
  /** Promise face, see Faces: same operations and delegates with Promise results, SQL on the given executor. */
  promise(executor: SqlExecutor): Promised<Client<Ts>>
} & {
  /**
   * Type delegate: `write` (entry or list of this Type), `get`, `query`, `delete` with `type` bound and removed from input, so `umwelt.Track.write(entry)` omits it;
   * `history` only when the Type has `history`. `check` and `deploy` are Client's only.
   */
  [N in TypeName<Ts[number]>]: TypeDelegate<TypeNamed<Ts, N>>
}
```

## Operations

Operations take only Types of the Client's Model.
Runtime enforces what TypeScript cannot: schema checks like `Schema.isGreaterThan(0)` at Write; integers for `take` and `skip` at Query and Get; input matching exactly one member of its input type, so keys the types do not allow, string or symbol, or conditions they keep apart, anywhere in input, are rejected with `ValidationFailed`, never dropped, since TypeScript object types are open and a variable with extra keys fits the type.
Reads decode stored content without schema checks: Write and Deploy keep it valid.
Effect's `SqlError` passes through every operation unchanged; failure kinds in the documents name Umwelt's own.
Declarations are [Check](client/check.md)'s; their types help, exactness is not required there.
Failure kinds cover stored state, those runtime checks, and value facts like same Identity twice in one list.
`undefined` in input means not given, as in JSON: dropped at every level of input objects, rejected inside arrays with `ValidationFailed`; `Umwelt.absent` names a missing field, see [Write](client/write.md).

| Document | Read when |
| :-- | :-- |
| [Write](client/write.md) | writing Objects: upsert, conditions, overlay, entry lists. |
| [Get](client/get.md) | reading Objects by Object ID, one or a list. |
| [Query](client/query.md) | reading Objects: `where`, `orderBy`, pagination, include, result shape. |
| [Delete](client/delete.md) | deleting Objects by selection, `ids`, `allowAll`, blocked deletes. |
| [History](client/history.md) | reading previous states of one Object. |
| [Check](client/check.md) | checking Model, Migrations, and Ledger before Deploy: Change shape, blocking reasons. |
| [Deploy](client/deploy.md) | applying pending Migrations: tables, steps, Ledger. |

## Vocabulary

Types the operation documents share. Each is read inside `Client<Ts>`: `AnyType` stands for `Ts[number]`, and every relation placeholder `Reference<N>` resolves to the Identity of the Model's Type named N.

```ts
type AnyType                                  // Type definition from `Umwelt.type`, see Type
type Model                                    // readonly AnyType[], see Model
type TypeNamed<Ts extends Model, N extends string>  // the Type in Ts named N
type TypeDelegate<T extends AnyType>          // Client operations with `type` bound to T
type HistoryType                              // AnyType declared with option `history`
type TypeName<T extends AnyType>              // its name string
type Payload<T extends AnyType>               // `Type` side of its schema with Reference<N> resolved, see Object
type Identity<T extends AnyType>              // subset of Payload<T> named by unique key
type ObjectId<T extends AnyType>              // opaque, branded per Type; only Umwelt makes one, see Object
type ObjectReference<T extends AnyType> = T extends AnyType ? { type: TypeName<T>; id: ObjectId<T> } : never  // distributes, so unions keep type and id paired
type Reference<N extends string>                    // placeholder a relation field holds before resolution, see Relations
type HasUniqueKey<T extends AnyType>          // `true` when T declares unique key
type Absent                                   // `typeof Umwelt.absent`, see Write
type RequiredKeys<P>, OptionalKeys<P>         // keys of P that are required, keys that are optional
type AtLeastOne<O>                            // O with at least one key present
type ExactlyOne<O>                            // O with exactly one key present
type RelationSlot<T extends AnyType>          // relation fields of T
type OneSlot<T extends AnyType>               // RelationSlot<T> holding one target
type Target<T extends AnyType, S extends RelationSlot<T>>  // target Type of slot S, resolved in Ts
type RelationField<S extends AnyType, K extends RelationSlot<S>, I = {}>  // relation field of S as value, `Play.fields.track`, see Relations
type Migration                                // one entry of the chain, see Model
type SqlExecutor                              // `pg` pool, client, or transaction client, or `(sql, parameters) => Promise<rows>` on one connection
type Promised<C>                              // C with every operation returning Promise instead of Effect, without `promise`
```

## Faces

Client has two faces with the same types, operations, and delegates.
Effect face: operations return Effect and need `SqlClient` from Effect context.
Promise face, `umwelt.promise(executor)`: operations return Promise, failures are thrown as the same error classes with `_tag`, SQL runs on the executor, host's connection or transaction. Effect applications use the Effect face.
Types stay Effect Schema on both faces: library import, no Effect runtime in application code; `Schema.decodeUnknownSync` and `Schema.decodeUnknownPromise` serve apps without Effect.
Migrations and `umwelt create` are files, face-free.

## Transactions

Umwelt has no own transaction API.
Every operation runs on Effect `SqlClient` from Effect context, or on the executor given to the Promise face.
Inside host transaction, Umwelt changes commit or roll back with host's other changes; without host transaction, each operation commits on its own, completely or not at all.
Failed operation leaves nothing of itself behind, inside host transaction too.
Guarantees against concurrent Deploy and Delete hold for host transactions at Postgres default isolation, READ COMMITTED.
