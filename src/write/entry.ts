/** One Write entry, checked against its input type and brought into the shape Write applies. */
import { Effect } from "effect"
import { absent } from "../absent.ts"
import { encode, exact, givenValue, identityOf, invalid, optionalFields, typeOf, type Input } from "../input.ts"
import type { ResolvedModel, ResolvedType } from "../resolve.ts"

type Address = { readonly identity: string } | { readonly id: string } | undefined

/** Payload fields as given, and the optional fields `Umwelt.absent` names. */
type Fields = { readonly fields: Input; readonly removed: ReadonlySet<string> }
/** mustMatch: stored JSON per given field, and the fields that must be missing. */
export type Match = { readonly fields: Input; readonly missing: ReadonlySet<string> }

export type Entry = {
    readonly type: ResolvedType
    /** `data` as given: no `undefined`, no `absent`. */
    readonly data: Input
    /** Optional fields `data` removes. */
    readonly removed: ReadonlySet<string>
    /** Identity as stored JSON, Object ID, or none: the entry creates. */
    readonly address: Address
    readonly condition: "mustExist" | "mustNotExist" | undefined
    readonly match: Match | undefined
    /** Stored JSON of `data` when it is complete state; `undefined` when it overlays. */
    readonly state: unknown
}

const entryKeys = ["type", "data", "id", "mustExist", "mustNotExist", "mustMatch"]
const conditionKeys = ["mustExist", "mustNotExist", "mustMatch"] as const

const pick = (data: Input, keys: readonly string[]) =>
    Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]))

/** Payload fields of `type` as given; `absent` on an optional top-level field is collected, on a required one invalid: `data` and `mustMatch`. */
const fieldsOf = (type: ResolvedType, value: unknown, context: string) =>
    Effect.gen(function* () {
        const at = `${type.name} ${context}`
        const entries = Object.entries(yield* exact(value, [...type.fields.keys()], at))
        const optional = optionalFields(type)
        const required = entries.find(([key, item]) => item === absent && !optional.has(key))
        if (required !== undefined) return yield* invalid(`${at}: absent on required field ${required[0]}`)
        const fields = yield* Effect.forEach(
            entries.filter(([, item]) => item !== absent),
            ([key, item]) => Effect.map(givenValue(item, `${at} ${key}`), (clean) => [key, clean] as const)
        )
        return {
            fields: Object.fromEntries(fields),
            removed: new Set(entries.filter(([, item]) => item === absent).map(([key]) => key))
        } satisfies Fields
    })

const expectedOf = (type: ResolvedType, key: string, expected: unknown) => {
    const codec = type.fields.get(key)
    if (codec === undefined) return invalid(`${type.name} has no field ${key}`)
    return encode(codec, expected, `${type.name} mustMatch ${key}`)
}

const matchOf = (type: ResolvedType, value: unknown) =>
    Effect.gen(function* () {
        const { fields, removed: missing } = yield* fieldsOf(type, value, "mustMatch")
        if (Object.keys(fields).length === 0 && missing.size === 0)
            return yield* invalid(`${type.name} mustMatch needs at least one field`)
        const expected = yield* Effect.forEach(Object.entries(fields), ([key, item]) =>
            Effect.map(expectedOf(type, key, item), (json) => [key, json] as const)
        )
        return { fields: Object.fromEntries(expected), missing } satisfies Match
    })

/** Identity in `data` for Types with unique key, `id` beside it for Types without. */
const addressOf = (type: ResolvedType, input: Input, data: Input) =>
    Effect.gen(function* () {
        if (type.identity !== undefined) {
            if ("id" in input) return yield* invalid(`${type.name} is addressed by Identity, not by id`)
            return { identity: yield* identityOf(type, pick(data, type.uniqueKey)) }
        }
        if ("mustExist" in input || "mustNotExist" in input)
            return yield* invalid(`${type.name} has no unique key: no mustExist or mustNotExist`)
        if ("id" in input) {
            const id = input["id"]
            return typeof id === "string" ? { id } : yield* invalid(`${type.name} id must be an Object ID`)
        }
        if ("mustMatch" in input) return yield* invalid(`${type.name} creates without id: no mustMatch`)
        return undefined
    })

const conditionOf = (type: ResolvedType, input: Input) => {
    const present = conditionKeys.filter((key) => key in input)
    if (present.length > 1) return invalid(`${type.name} entry takes one condition at most`)
    const [condition] = present
    if (condition === undefined || condition === "mustMatch") return Effect.undefined
    return input[condition] === true ? Effect.succeed(condition) : invalid(`${type.name} ${condition} must be true`)
}

export const entryOf = (model: ResolvedModel, value: unknown) =>
    Effect.gen(function* () {
        const input = yield* exact(value, entryKeys, "Write entry")
        const type = yield* typeOf(model, input["type"])
        const { fields: data, removed } = yield* fieldsOf(type, input["data"], "data")
        const condition = yield* conditionOf(type, input)
        const address: Address = yield* addressOf(type, input, data)
        const match = "mustMatch" in input ? yield* matchOf(type, input["mustMatch"]) : undefined
        const complete = condition === "mustNotExist" || (type.identity === undefined && address === undefined)
        const state = complete ? yield* encode(type.json, data, type.name) : undefined
        return { type, data, removed, address, condition, match, state } satisfies Entry
    })
