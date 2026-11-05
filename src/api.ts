/** Client types: what application code writes and gets back, derived from the Model. */
import type { Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { Absent } from "./absent.ts"
import type {
    AnyType,
    AtLeastOne,
    Cursor,
    ObjectId,
    OneSlot,
    OptionalKeys,
    OrderBy,
    TimeWhere,
    Reference,
    RelationSlot,
    RequiredKeys,
    TargetName,
    TypeName,
    WhereField
} from "./declaration.ts"
import type {
    BlockingReason,
    Blocked,
    ConditionRejected,
    DuplicateIdentity,
    MigrationFailed,
    MissingTarget,
    ModelMismatch,
    ReferencedByHost,
    UniqueViolation,
    ValidationFailed
} from "./errors.ts"

type Sql = SqlClient.SqlClient
type DistributiveOmit<U, K extends PropertyKey> = U extends unknown ? Omit<U, K> : never

// ---------------------------------------------------------------- faces
/** Effect face: operations return Effect and need SqlClient from context. Promise face: Promise, failures thrown. */
export type Face = "effect" | "promise"
type Returned<F extends Face, A, E> = F extends "effect" ? Effect.Effect<A, E | SqlError.SqlError, Sql> : Promise<A>
/** One connection, like a `pg` client or the client of a host transaction. */
export type Queryable = { query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: readonly unknown[] }> }
/** Lends one connection per Umwelt transaction, like a `pg` pool; its `query` serves single statements. */
export type Lender = Queryable & { connect(): Promise<Queryable & { release(): void }>; readonly totalCount: number }
/** Runs every statement on one connection, like a driver's transaction callback; rows parsed as `pg` parses them. */
export type Run = (sql: string, parameters: readonly unknown[]) => Promise<readonly unknown[]>
/** What runs SQL for the Promise face: `pg` pool, client, or transaction client, or a function; Effect applications use the Effect face. */
export type SqlExecutor = Lender | Queryable | Run

// ---------------------------------------------------------------- model
export type Model = readonly AnyType[]
export type TypeNamed<Ts extends Model, N extends string> = Extract<Ts[number], { readonly name: N }>
export type Identity<T extends AnyType> = Schema.Struct.Type<T["~uniqueKey"]>
export type HasUniqueKey<T extends AnyType> = [keyof T["~uniqueKey"]] extends [never] ? false : true
export type HistoryType = AnyType & { readonly "~mutability": { history: true } }
export type ObjectReference<T extends AnyType> = T extends AnyType ? { type: TypeName<T>; id: ObjectId<T> } : never

/** Payload with every Reference<N> resolved to the Identity of the Model's Type named N. */
type Resolve<Ts extends Model, V> =
    V extends Reference<infer N>
        ? Identity<TypeNamed<Ts, N>>
        : V extends Date
          ? V
          : V extends readonly (infer E)[]
            ? readonly Resolve<Ts, E>[]
            : V extends object
              ? { [K in keyof V]: Resolve<Ts, V[K]> }
              : V
export type Payload<Ts extends Model, T extends AnyType> = Resolve<Ts, T["Type"]>
export type Target<Ts extends Model, T extends AnyType, S extends RelationSlot<T>> = TypeNamed<Ts, TargetName<T, S>>

// ---------------------------------------------------------------- where
type RelationOne<Ts extends Model, T extends AnyType, S extends RelationSlot<T>> = AtLeastOne<{
    is?: Where<Ts, Target<Ts, T, S>>
    isNot?: Where<Ts, Target<Ts, T, S>>
}>
type RelationMany<Ts extends Model, T extends AnyType, S extends RelationSlot<T>> = AtLeastOne<{
    some?: Where<Ts, Target<Ts, T, S>>
    every?: Where<Ts, Target<Ts, T, S>>
    none?: Where<Ts, Target<Ts, T, S>>
}>
/** Prisma's where with relation filters: `is`/`isNot` on one, `some`/`every`/`none` on many, each taking the target's where. */
export type Where<Ts extends Model, T extends AnyType> = AtLeastOne<
    {
        [F in keyof Payload<Ts, T>]?:
            | (F extends OneSlot<T>
                  ? RelationOne<Ts, T, F>
                  : F extends RelationSlot<T>
                    ? RelationMany<Ts, T, F>
                    : WhereField<Payload<Ts, T>[F]>)
            | (F extends OptionalKeys<Payload<Ts, T>> ? Absent : never)
    } & TimeWhere & {
            AND?: readonly [Where<Ts, T>, ...Where<Ts, T>[]]
            OR?: readonly [Where<Ts, T>, ...Where<Ts, T>[]]
            NOT?: Where<Ts, T>
        }
>

// ---------------------------------------------------------------- include
type IncludeOf<E> = E extends { readonly "~include": infer J } ? J : E extends { include: infer J } ? J : {}
type SourceOf<E> = E extends { readonly "~source": infer S extends AnyType } ? S : never
type Refinement<Ts extends Model, T extends AnyType, I> = {
    where?: Where<Ts, T>
    orderBy?: OrderBy<Payload<Ts, T>>
    take?: number
    skip?: number
    cursor?: Cursor<T>
    include?: Include<Ts, T, I>
}
/** Relation field keys take `true` or refinement; every other key takes a RelationField pointing at T. */
export type Include<Ts extends Model, T extends AnyType, I> = {
    [K in keyof I]: K extends OneSlot<T>
        ?
              | true
              | {
                    include?: Include<Ts, Target<Ts, T, K>, IncludeOf<I[K]>>
                    where?: never
                    orderBy?: never
                    take?: never
                    skip?: never
                    cursor?: never
                }
        : K extends RelationSlot<T>
          ? true | Refinement<Ts, Target<Ts, T, K>, IncludeOf<I[K]>>
          : PointingAt<Ts, T, I[K]>
}
type PointingAt<Ts extends Model, T extends AnyType, E> = E extends {
    readonly "~source": infer S extends AnyType
    readonly "~include": infer J
}
    ? { readonly "~source": Ts[number]; readonly "~target": TypeName<T>; readonly "~include": Include<Ts, S, J> }
    : never

// ---------------------------------------------------------------- results
export type QueryObject<Ts extends Model, T extends AnyType, I = {}> = {
    type: TypeName<T>
    id: ObjectId<T>
    /** Set by Umwelt from the database clock: on create, and on every Write changing payload; Deploy keeps both. */
    createdAt: Date
    changedAt: Date
    payload: Payload<Ts, T>
    relations: {
        [K in keyof I]: K extends OneSlot<T>
            ? QueryObject<Ts, Target<Ts, T, K>, IncludeOf<I[K]>> | null
            : K extends RelationSlot<T>
              ? QueryObject<Ts, Target<Ts, T, K>, IncludeOf<I[K]>>[]
              : QueryObject<Ts, SourceOf<I[K]>, IncludeOf<I[K]>>[]
    }
}
export type QueryResult<Ts extends Model, T extends AnyType, I> = {
    objects: QueryObject<Ts, T, I>[]
    /** More Objects follow `take`. */
    pageInfo: { hasMore: boolean }
}

// ---------------------------------------------------------------- errors per operation
export type WriteError =
    | ConditionRejected
    | DuplicateIdentity
    | UniqueViolation
    | ValidationFailed
    | MissingTarget
    | ModelMismatch
export type ReadError = ValidationFailed | ModelMismatch
export type DeleteError = ValidationFailed | ReferencedByHost | ModelMismatch
export type DeployError = Blocked | MigrationFailed | MissingTarget | UniqueViolation

// ---------------------------------------------------------------- write
/** Required fields take a value; optional fields take a value or `Umwelt.absent`, which removes the field. */
type Overlay<P> = { [K in RequiredKeys<P>]?: P[K] } & { [K in OptionalKeys<P>]?: P[K] | Absent }
type ChangeInput<Ts extends Model, T extends AnyType> = Identity<T> & Overlay<Omit<Payload<Ts, T>, keyof Identity<T>>>
type MatchInput<Ts extends Model, T extends AnyType> = AtLeastOne<Overlay<Payload<Ts, T>>>
type IdentityEntry<Ts extends Model, T extends AnyType> =
    | { data: ChangeInput<Ts, T>; mustExist?: never; mustNotExist?: never; mustMatch?: never; id?: never }
    | { data: Payload<Ts, T>; mustNotExist: true; mustExist?: never; mustMatch?: never; id?: never }
    | { data: ChangeInput<Ts, T>; mustExist: true; mustNotExist?: never; mustMatch?: never; id?: never }
    | { data: ChangeInput<Ts, T>; mustMatch: MatchInput<Ts, T>; mustExist?: never; mustNotExist?: never; id?: never }
type IdEntry<Ts extends Model, T extends AnyType> =
    | { data: Payload<Ts, T>; id?: never; mustMatch?: never; mustExist?: never; mustNotExist?: never }
    | {
          id: ObjectId<T>
          data: Overlay<Payload<Ts, T>>
          mustMatch?: MatchInput<Ts, T>
          mustExist?: never
          mustNotExist?: never
      }
export type WriteEntry<Ts extends Model, T extends AnyType> = T extends AnyType
    ? { type: T } & (HasUniqueKey<T> extends true ? IdentityEntry<Ts, T> : IdEntry<Ts, T>)
    : never
export type WriteResult<T extends AnyType> = { id: ObjectId<T>; outcome: "created" | "changed" | "unchanged" }

export type Write<Ts extends Model, F extends Face = "effect"> = {
    <T extends Ts[number]>(entry: WriteEntry<Ts, T>): Returned<F, WriteResult<T>, WriteError>
    (entries: readonly WriteEntry<Ts, Ts[number]>[]): Returned<F, WriteResult<Ts[number]>[], WriteError>
}

// ---------------------------------------------------------------- get / query / delete / history
type NonEmptyIds<T extends AnyType> = readonly [ObjectId<T>, ...ObjectId<T>[]]
export type GetOne<T extends AnyType, I> = { type: T; id: ObjectId<T>; ids?: never; include?: I }
export type GetMany<T extends AnyType, I> = { type: T; ids: NonEmptyIds<T>; id?: never; include?: I }
export type Get<Ts extends Model, F extends Face = "effect"> = {
    /** One Object by Object ID; `null` when unknown. */
    <T extends Ts[number], const I extends Include<Ts, T, I> = {}>(
        input: GetOne<T, I>
    ): Returned<F, QueryObject<Ts, T, I> | null, ReadError>
    /** Objects in input order; `null` where unknown. */
    <T extends Ts[number], const I extends Include<Ts, T, I> = {}>(
        input: GetMany<T, I>
    ): Returned<F, (QueryObject<Ts, T, I> | null)[], ReadError>
}

export type QueryInput<Ts extends Model, T extends AnyType, I> = {
    type: T
    where?: Where<Ts, T>
    orderBy?: OrderBy<Payload<Ts, T>>
    take?: number
    skip?: number
    cursor?: Cursor<T>
    include?: I
}
export type Query<Ts extends Model, F extends Face = "effect"> = {
    <T extends Ts[number], const I extends Include<Ts, T, I> = {}>(
        input: QueryInput<Ts, T, I>
    ): Returned<F, QueryResult<Ts, T, I>, ReadError>
}

type Selected<S> = S extends readonly AnyType[] ? S[number] : S
type DeleteSelection<Ts extends Model, T extends AnyType> =
    | { where: Where<Ts, T>; ids?: never; allowAll?: never }
    | { ids: NonEmptyIds<T>; where?: never; allowAll?: never }
    | { allowAll: true; where?: true; ids?: never }
    | { where: false; ids?: never; allowAll?: never }
export type DeleteInput<Ts extends Model, S> = { type: S } & DeleteSelection<Ts, Selected<S> & AnyType>
/** open: how relation field inside payload is named; Umwelt names it like `entries[].track`. */
export type RelationPath = string
/** open: blocked selection as result or as typed error; result here. */
export type DeleteResult<T extends AnyType> = {
    matched: ObjectReference<T>[]
    deleted: ObjectReference<T>[]
    /** Objects whose delete strict relations block, with each blocking relation: source Object and its relation field. */
    blocked: { object: ObjectReference<T>; blockedBy: { source: ObjectReference<AnyType>; field: RelationPath }[] }[]
}
export type Delete<Ts extends Model, F extends Face = "effect"> = {
    <S extends Ts[number] | readonly [Ts[number], ...Ts[number][]]>(
        input: DeleteInput<Ts, S>
    ): Returned<F, DeleteResult<Selected<S> & AnyType>, DeleteError>
}

export type HistoryEntry<Ts extends Model, T extends AnyType> = { payload: Payload<Ts, T>; replacedAt: Date }
export type HistoryInput<T extends AnyType> = { type: T; object: ObjectId<T> | Identity<T> }
export type History<Ts extends Model, F extends Face = "effect"> = {
    <T extends Extract<Ts[number], HistoryType>>(input: HistoryInput<T>): Returned<F, HistoryEntry<Ts, T>[], ReadError>
}

// ---------------------------------------------------------------- check / deploy
export type MigrationKind = "safe" | "transforming" | "destructive"
export type PendingMigration = {
    id: string
    /** Per touched Type: kind, see Model, and Objects the step touches. */
    types: { readonly [type: string]: { kind: MigrationKind; objects: number } }
}
/** Empty `pending` with empty `blocking` means up to date; any blocking reason means Deploy fails. */
export type Change = { pending: readonly PendingMigration[]; blocking: readonly BlockingReason[] }
export type Deployed = { applied: readonly string[] }

export type Check<F extends Face = "effect"> = () => Returned<F, Change, never>
export type Deploy<F extends Face = "effect"> = () => Returned<F, Deployed, DeployError>

// ---------------------------------------------------------------- Client
export type TypeDelegate<Ts extends Model, T extends AnyType, F extends Face = "effect"> = {
    write: {
        (entry: DistributiveOmit<WriteEntry<Ts, T>, "type">): Returned<F, WriteResult<T>, WriteError>
        (entries: readonly DistributiveOmit<WriteEntry<Ts, T>, "type">[]): Returned<F, WriteResult<T>[], WriteError>
    }
    get: {
        <const I extends Include<Ts, T, I> = {}>(
            input: Omit<GetOne<T, I>, "type">
        ): Returned<F, QueryObject<Ts, T, I> | null, ReadError>
        <const I extends Include<Ts, T, I> = {}>(
            input: Omit<GetMany<T, I>, "type">
        ): Returned<F, (QueryObject<Ts, T, I> | null)[], ReadError>
    }
    query: <const I extends Include<Ts, T, I> = {}>(
        input: Omit<QueryInput<Ts, T, I>, "type">
    ) => Returned<F, QueryResult<Ts, T, I>, ReadError>
    delete: (input: DeleteSelection<Ts, T>) => Returned<F, DeleteResult<T>, DeleteError>
} & (T extends HistoryType
    ? { history: (input: Omit<HistoryInput<T>, "type">) => Returned<F, HistoryEntry<Ts, T>[], ReadError> }
    : {})

/** Operations and Type delegates of one face. */
export type Operations<Ts extends Model, F extends Face> = {
    write: Write<Ts, F>
    get: Get<Ts, F>
    query: Query<Ts, F>
    delete: Delete<Ts, F>
    history: History<Ts, F>
    check: Check<F>
    deploy: Deploy<F>
} & { [T in Ts[number] as TypeName<T>]: TypeDelegate<Ts, T, F> }

export type Client<Ts extends Model> = Operations<Ts, "effect"> & {
    /** Same Client on Promises, running SQL on the given executor; inside host's transaction it commits with the host. */
    promise(executor: SqlExecutor): Operations<Ts, "promise">
}

/** Client C with every operation returning Promise instead of Effect, without `promise`. */
export type Promised<C extends { promise(executor: SqlExecutor): object }> = ReturnType<C["promise"]>
