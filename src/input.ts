/** Runtime input checks of every operation: input must match exactly one member of its input type, see Client. */
import { Effect, Schema, SchemaAST } from "effect"
import { absent } from "./absent.ts"
import { canonicalJson } from "./canonical.ts"
import { ValidationFailed } from "./errors.ts"
import type { ResolvedModel, ResolvedType } from "./resolve.ts"

export type Input = { readonly [key: string]: unknown }

export const invalid = (message: string) => Effect.fail(new ValidationFailed({ message }))

export const isRecord = (value: unknown): value is Input =>
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

/** Own entries of a record, string and symbol keys alike: every reader of `where` and `orderBy` sees the same keys. */
export const entriesOf = (record: Input): readonly (readonly [string | symbol, unknown])[] =>
    Reflect.ownKeys(record).map((key) => [key, Reflect.get(record, key)])

/** The record when it is one and holds only allowed keys, without its `undefined` values; a symbol key is never allowed. */
export const exact = (value: unknown, allowed: readonly string[], context: string) => {
    if (!isRecord(value)) return invalid(`${context} takes an object`)
    const entries = entriesOf(value).filter(([, item]) => item !== undefined)
    const wrong = entries.find(([key]) => typeof key !== "string" || !allowed.includes(key))
    return wrong === undefined
        ? Effect.succeed(Object.fromEntries(entries))
        : invalid(`${context} does not allow ${String(wrong[0])}`)
}

/**
 * A payload value as given: `undefined` entries of objects are dropped at any depth; `undefined` inside arrays is
 * invalid, since JSON would turn it into null; `absent` below the top level is invalid.
 */
export const givenValue = (item: unknown, at: string) => given(item, at, false)

/** A `where` as given: like a payload value, but `absent` and symbol keys stay at any depth, as `where` reads them. */
export const givenWhere = (item: unknown, at: string) => given(item, at, true)

const given = (item: unknown, at: string, where: boolean): Effect.Effect<unknown, ValidationFailed> => {
    if (item === absent && !where) return invalid(`${at}: absent is allowed on top-level optional fields only`)
    if (Array.isArray(item)) {
        return Effect.forEach(item, (element, index) =>
            element === undefined ? invalid(`${at}[${index}] is undefined`) : given(element, `${at}[${index}]`, where)
        )
    }
    if (!isRecord(item)) return Effect.succeed(item)
    const entries = entriesOf(item).filter(([, value]) => value !== undefined)
    const symbol = where ? undefined : entries.find(([key]) => typeof key === "symbol")
    if (symbol !== undefined) return invalid(`${at} does not allow ${String(symbol[0])}`)
    return Effect.map(
        Effect.forEach(entries, ([key, value]) =>
            Effect.map(given(value, `${at}.${String(key)}`, where), (clean) => [key, clean] as const)
        ),
        Object.fromEntries
    )
}

/** The Type of the Client's Model that `type` is. */
export const typeOf = (model: ResolvedModel, type: unknown) => {
    const resolved = model.byType.get(type)
    return resolved === undefined ? invalid("type is not a Type of the Client's Model") : Effect.succeed(resolved)
}

/** Stored JSON of a Type-side value; excess keys and misfits fail with ValidationFailed, schema checks too unless disabled. */
export const encode = (
    codec: Schema.Codec<unknown, unknown>,
    value: unknown,
    at: string,
    options?: { readonly disableChecks: boolean }
) =>
    Schema.encodeUnknownEffect(codec)(value, { ...options, onExcessProperty: "error" }).pipe(
        Effect.mapError((error) => new ValidationFailed({ message: `${at}: ${error.message}` }))
    )

/** Identity as canonical stored JSON; `value` must hold exactly the unique key fields. */
export const identityOf = (type: ResolvedType, value: unknown) =>
    type.identity === undefined
        ? invalid(`${type.name} has no unique key`)
        : Effect.map(encode(type.identity, value, `${type.name} Identity`), canonicalJson)

/** Top-level payload fields declared with `Schema.optionalKey`. */
export const optionalFields = (type: ResolvedType): ReadonlySet<string> =>
    new Set(
        SchemaAST.isObjects(type.payload.ast)
            ? type.payload.ast.propertySignatures
                  .filter((field) => SchemaAST.isOptional(field.type))
                  .map((field) => String(field.name))
            : []
    )
