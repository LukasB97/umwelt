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

/** Entries of a record whose values are given: `undefined` means not given, as in JSON. */
export const givenEntries = (value: Input) => Object.entries(value).filter(([, item]) => item !== undefined)

/** The record when it is one and holds only allowed keys, without its `undefined` values. */
export const exact = (value: unknown, allowed: readonly string[], context: string) => {
    if (!isRecord(value)) return invalid(`${context} takes an object`)
    const entries = givenEntries(value)
    const wrong = entries.find(([key]) => !allowed.includes(key))
    return wrong === undefined
        ? Effect.succeed(Object.fromEntries(entries))
        : invalid(`${context} does not allow ${wrong[0]}`)
}

/**
 * A payload value as given: `undefined` entries of objects are dropped at any depth; `undefined` inside arrays is
 * invalid, since JSON would turn it into null; `absent` below the top level is invalid.
 */
export const givenValue = (item: unknown, at: string): Effect.Effect<unknown, ValidationFailed> => {
    if (item === absent) return invalid(`${at}: absent is allowed on top-level optional fields only`)
    if (Array.isArray(item)) return givenItems(item, at)
    if (isRecord(item)) return givenRecord(item, at)
    return Effect.succeed(item)
}

const givenItems = (items: readonly unknown[], at: string) =>
    Effect.forEach(items, (element, index) =>
        element === undefined ? invalid(`${at}[${index}] is undefined`) : givenValue(element, `${at}[${index}]`)
    )

const givenRecord = (record: Input, at: string) =>
    Effect.map(
        Effect.forEach(givenEntries(record), ([key, element]) =>
            Effect.map(givenValue(element, `${at}.${key}`), (clean) => [key, clean] as const)
        ),
        (entries) => Object.fromEntries(entries)
    )

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
