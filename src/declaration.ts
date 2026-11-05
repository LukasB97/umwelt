/** Types for declaring a Model: Type, relations, and relation fields as values. */
import type { Schema, SchemaAST } from "effect"
import type { Absent } from "./absent.ts"
import type { ChangedAt, CreatedAt } from "./times.ts"

export type Simplify<T> = { [K in keyof T]: T[K] } & {}
export type RequiredKeys<P> = { [K in keyof P]-?: {} extends Pick<P, K> ? never : K }[keyof P]
export type OptionalKeys<P> = { [K in keyof P]-?: {} extends Pick<P, K> ? K : never }[keyof P]
/** O with at least one key present. */
export type AtLeastOne<O> = O & { [K in keyof O]-?: Required<Pick<O, K>> }[keyof O]
/** Exactly one key of O. */
type ExactlyOne<O> = { [K in keyof O]-?: Required<Pick<O, K>> & { [P in Exclude<keyof O, K>]?: never } }[keyof O]

export type Fields = Schema.Struct.Fields
export type Mutability = { immutable?: false; history?: boolean } | { immutable: true; history?: never }
/** Names of Client members; a Type named like one would shadow it. */
export type ReservedTypeName = "write" | "get" | "query" | "delete" | "history" | "check" | "deploy" | "promise"
export type SubFields<F extends Fields> = { [K in keyof F]?: F[K] }

declare const IdTag: unique symbol
/** Opaque Object ID, branded per Type. Only Umwelt makes one. */
export type ObjectId<T> = string & { readonly [IdTag]: T }

declare const ReferenceTag: unique symbol
/** Placeholder a relation field holds before Client resolves it to the target Identity. */
export interface Reference<N extends string> {
    readonly [ReferenceTag]: N
}

export type Cardinality = "one" | "many"
export type RelationMode = "strict" | "sparse"

export interface Relation<N extends string, C extends Cardinality, Mode extends RelationMode> extends Schema.Codec<
    C extends "one" ? Reference<N> : readonly Reference<N>[]
> {
    readonly "~mode": Mode
    sparse(): Relation<N, C, "sparse">
}

type SlotInfo<S> =
    S extends Schema.Codec<infer X>
        ? X extends Reference<infer N>
            ? { target: N; card: "one" }
            : X extends readonly Reference<infer N>[]
              ? { target: N; card: "many" }
              : never
        : never
type RelationKeys<F> = { [K in keyof F]: [SlotInfo<F[K]>] extends [never] ? never : K }[keyof F] & string

/** What every Type has; Client types read these members. */
export interface AnyType {
    readonly name: string
    readonly ast: SchemaAST.Objects
    readonly fields: Fields
    readonly "~fields": Fields
    readonly Type: unknown
    readonly "~uniqueKey": Fields
    readonly "~mutability": Mutability
}

/** Type is an Effect Schema of its payload, plus name, ObjectId, and relation fields as values. */
export interface Type<
    N extends string,
    F extends Fields,
    UK extends Fields,
    M extends Mutability
> extends Schema.Struct<F> {
    readonly name: N
    /** Decodes stored string to ObjectId of this Type, for host columns. */
    readonly ObjectId: Schema.Codec<ObjectId<Type<N, F, UK, M>>, string>
    /** Effect's fields; relation fields additionally carry RelationField, so `Play.fields.track` is an edge. */
    readonly fields: F & { readonly [K in RelationKeys<F>]: RelationField<Type<N, F, UK, M>, K, {}> }
    readonly "~fields": F
    readonly "~uniqueKey": UK
    readonly "~mutability": M
}

export type TypeName<T extends AnyType> = T["name"]
export type RelationSlot<T extends AnyType> = RelationKeys<T["~fields"]>
export type OneSlot<T extends AnyType> = {
    [S in RelationSlot<T>]: SlotInfo<T["~fields"][S]>["card"] extends "one" ? S : never
}[RelationSlot<T>]
export type TargetName<T extends AnyType, S extends RelationSlot<T>> = SlotInfo<T["~fields"][S]>["target"]

type Scalar = string | number | boolean | Date | null
export type FieldFilter<V> = AtLeastOne<
    { equals?: V; in?: readonly V[] } & (NonNullable<V> extends number | string | Date
        ? { lt?: NonNullable<V>; gt?: NonNullable<V> }
        : {}) &
        (NonNullable<V> extends string ? { contains?: string } : {})
>
/** Scalar field: bare value or operators. Object and array fields: operators only. */
export type WhereField<V> =
    NonNullable<V> extends Scalar
        ? Exclude<V, undefined> | FieldFilter<Exclude<V, undefined>>
        : FieldFilter<Exclude<V, undefined>>
/** `Umwelt.createdAt` and `Umwelt.changedAt` as `where` keys: like a required Date field. */
export type TimeWhere = { [K in CreatedAt | ChangedAt]?: WhereField<Date> }
/** Where over an unresolved payload, for RelationField outside the Client; relation fields are unusable there. */
export type SimpleWhere<P> = AtLeastOne<
    { [F in keyof P]?: WhereField<P[F]> | (F extends OptionalKeys<P> ? Absent : never) } & TimeWhere & {
            AND?: readonly [SimpleWhere<P>, ...SimpleWhere<P>[]]
            OR?: readonly [SimpleWhere<P>, ...SimpleWhere<P>[]]
            NOT?: SimpleWhere<P>
        }
>
/** Sort kind of a non-null value type: one of number, string, or Date; `never` for mixed unions and for nothing. */
type SortKind<V> = [V] extends [never]
    ? never
    : [V] extends [number]
      ? number
      : [V] extends [string]
        ? string
        : [V] extends [Date]
          ? Date
          : never
/** Keys of P holding number, string, or Date, also nullable or optional; mixed unions and null-only fields are excluded. */
export type SortableKeys<P> = { [K in keyof P]-?: [SortKind<NonNullable<P[K]>>] extends [never] ? never : K }[keyof P]
/** One field or time per entry; several as list, in list order. */
export type OrderEntry<P> = ExactlyOne<{ [F in SortableKeys<P> | CreatedAt | ChangedAt]: "asc" | "desc" }>
export type OrderBy<P> = OrderEntry<P> | readonly [OrderEntry<P>, ...OrderEntry<P>[]]
/** Object ID to continue after, exclusive, in the same `orderBy`. */
export type Cursor<T> = ObjectId<T>

/** What a RelationField recorded; same shape as a collection refinement in include. */
export type Refinement = {
    readonly where?: unknown
    readonly orderBy?: unknown
    readonly take?: number
    readonly skip?: number
    readonly cursor?: unknown
    readonly include?: unknown
}

/**
 * Relation field of S as value. Under any key of include on its target Type it reads the sources pointing there.
 * `where` and `orderBy` see S's own payload with relation fields unresolved; Model-dependent parts are checked at the include position.
 */
export interface RelationField<S extends AnyType, K extends RelationSlot<S>, I> {
    readonly "~source": S
    readonly "~field": K
    readonly "~target": TargetName<S, K>
    readonly "~include": I
    readonly "~refinement": Refinement
    where(where: SimpleWhere<S["Type"]>): RelationField<S, K, I>
    orderBy(orderBy: OrderBy<S["Type"]>): RelationField<S, K, I>
    take(n: number): RelationField<S, K, I>
    skip(n: number): RelationField<S, K, I>
    cursor(cursor: Cursor<S>): RelationField<S, K, I>
    include<const J extends object>(include: J): RelationField<S, K, J>
}
