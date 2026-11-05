/**
 * Read input checked against the Model: what Get and Query select, as a tree of Types and include edges.
 * Every key the input types do not allow fails with ValidationFailed, also a key present with `undefined`.
 */
import { Effect } from "effect"
import type { ValidationFailed } from "../errors.ts"
import { entriesOf, exact, invalid, isRecord, type Input } from "../input.ts"
import type { ResolvedModel, ResolvedType } from "../resolve.ts"
import { timeColumn, type TimeColumn } from "../times.ts"
import { isNumeric, kindsOf } from "../where.ts"

/** A payload field, or a time column. `numeric`: the field holds numbers, sorted by numeric value whatever their stored form. */
export type Order =
    | { readonly field: string; readonly descending: boolean; readonly numeric: boolean }
    | { readonly column: TimeColumn; readonly descending: boolean }

/** Selection inside one collection or the root; `cursor` is the Object ID to continue after. */
export type Page = {
    readonly where: unknown
    readonly orderBy: readonly Order[]
    readonly take: number | undefined
    readonly skip: number | undefined
    readonly cursor: string | undefined
}

/** `one`, `many`: relation field of the parent. `reverse`: relation field of a source Type pointing at the parent. */
type Link =
    | { readonly kind: "one" | "many"; readonly field: string }
    | { readonly kind: "reverse"; readonly field: string; readonly card: "one" | "many" }

export type Edge = { readonly key: string; readonly link: Link; readonly node: Node; readonly page: Page }
export type Node = { readonly type: ResolvedType; readonly edges: readonly Edge[] }

/** Every Object, in default order. */
export const all: Page = { where: undefined, orderBy: [], take: undefined, skip: undefined, cursor: undefined }
const refinementKeys = ["where", "orderBy", "take", "skip", "cursor", "include"]

const count = (value: unknown, key: string) =>
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        ? Effect.succeed(value)
        : invalid(`${key} takes a non-negative integer`)

const cursorOf = (value: unknown) =>
    value === undefined || typeof value === "string" ? Effect.succeed(value) : invalid("cursor takes an Object ID")

/** Orders by fields of one sort kind, number, string, or Date, also nullable; never by relation fields. */
const sortable = (type: ResolvedType, field: string) => !type.slots.has(field) && kindsOf(type, field)?.size === 1

const orderEntry = (type: ResolvedType, entry: unknown): Effect.Effect<Order, ValidationFailed> => {
    const entries = isRecord(entry) ? entriesOf(entry) : []
    const [key, direction] = entries[0] ?? []
    if (key === undefined || entries.length > 1 || (direction !== "asc" && direction !== "desc"))
        return invalid(`orderBy on ${type.name} takes one field per entry with "asc" or "desc"`)
    const descending = direction === "desc"
    if (typeof key === "symbol") {
        const column = timeColumn(key)
        return column === undefined
            ? invalid(`orderBy on ${type.name} takes no key ${String(key)}`)
            : Effect.succeed({ column, descending })
    }
    if (!sortable(type, key)) return invalid(`${type.name} has no sortable field ${key}`)
    return Effect.succeed({ field: key, descending, numeric: isNumeric(kindsOf(type, key)) })
}

const orderOf = (type: ResolvedType, orderBy: unknown) => {
    if (orderBy === undefined) return Effect.succeed([])
    if (!Array.isArray(orderBy)) return Effect.map(orderEntry(type, orderBy), (order) => [order])
    if (orderBy.length === 0) return invalid(`orderBy on ${type.name} takes a non-empty list`)
    return Effect.forEach(orderBy, (entry) => orderEntry(type, entry))
}

/** Page of a collection or the root; `where` is compiled with the SQL, against the Model. */
export const pageOf = (type: ResolvedType, input: Input) =>
    Effect.gen(function* () {
        return {
            where: input["where"],
            orderBy: yield* orderOf(type, input["orderBy"]),
            take: yield* count(input["take"], "take"),
            skip: yield* count(input["skip"], "skip"),
            cursor: yield* cursorOf(input["cursor"])
        }
    })

/** Include on `type`: relation fields of `type`, and RelationFields of Model Types pointing at it under any other key. */
export const includeOf = (
    model: ResolvedModel,
    type: ResolvedType,
    include: unknown
): Effect.Effect<readonly Edge[], ValidationFailed> => {
    if (include === undefined) return Effect.succeed([])
    if (!isRecord(include)) return invalid(`include on ${type.name} takes an object`)
    return Effect.forEach(Object.entries(include), ([key, value]) => edgeOf(model, type, key, value))
}

const edgeOf = (model: ResolvedModel, type: ResolvedType, key: string, value: unknown) =>
    Effect.gen(function* () {
        const slot = type.slots.get(key)
        if (slot === undefined) return yield* reverseOf(model, type, key, value)
        const target = model.types.get(slot.target)
        if (target === undefined) return yield* Effect.die(new Error(`${key} targets unknown Type ${slot.target}`))
        const link = { kind: slot.card, field: key }
        if (value === true) return { key, link, node: { type: target, edges: [] }, page: all }
        const allowed = slot.card === "one" ? ["include"] : refinementKeys
        const refinement = yield* exact(value, allowed, `include ${type.name}.${key}`)
        const node = { type: target, edges: yield* includeOf(model, target, refinement["include"]) }
        return { key, link, node, page: yield* pageOf(target, refinement) }
    })

/** RelationField under any other key: the sources pointing at the parent, with the field's refinement. */
const reverseOf = (model: ResolvedModel, type: ResolvedType, key: string, value: unknown) =>
    Effect.gen(function* () {
        const context = `include ${type.name}.${key}`
        const isEdge = (typeof value === "object" && value !== null) || typeof value === "function"
        if (!isEdge || !("~source" in value) || !("~field" in value))
            return yield* invalid(`${context} takes a relation field pointing at ${type.name}`)
        const source = model.byType.get(value["~source"])
        const field = value["~field"]
        const slot = typeof field === "string" ? source?.slots.get(field) : undefined
        if (source === undefined || typeof field !== "string" || slot?.target !== type.name)
            return yield* invalid(`${context} takes a relation field pointing at ${type.name}`)
        const refinement = yield* exact(Reflect.get(value, "~refinement"), refinementKeys, context)
        const node = { type: source, edges: yield* includeOf(model, source, refinement["include"]) }
        const link = { kind: "reverse", field, card: slot.card } as const
        return { key, link, node, page: yield* pageOf(source, refinement) }
    })
