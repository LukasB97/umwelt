/**
 * Kind of one step, decided on forms alone, see Model. Objects are taken as closed: stored payloads hold declared fields only.
 * Comparison is conservative: whatever it cannot prove to fit counts as not fitting.
 */
import type { MigrationKind } from "../api.ts"
import { canonicalJson, same } from "../canonical.ts"
import { definitionName, isSchema, list, type JsonSchema, type Step } from "../migration.ts"

/** `exact`: content fits unchanged. `dropping`: content fits once fields the form after lacks are dropped. */
type Mode = "exact" | "dropping"
type Comparison = {
    readonly before: JsonSchema
    readonly after: JsonSchema
    readonly mode: Mode
    readonly assumed: Set<string>
}

const lowerBounds = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"])
const upperBounds = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"])
const compared = new Set([
    "$defs",
    "$ref",
    "anyOf",
    "enum",
    "const",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "prefixItems"
])

const record = (value: unknown): JsonSchema => (isSchema(value) ? value : {})

const definition = (root: JsonSchema, schema: JsonSchema): unknown =>
    "$ref" in schema ? record(root["$defs"])[definitionName(schema["$ref"]) ?? ""] : schema

/** Recursive definitions: a pair under comparison is assumed to fit, and the assumption is dropped when it fails. */
const references = (comparison: Comparison, before: JsonSchema, after: JsonSchema): boolean => {
    const pair = `${canonicalJson(before["$ref"] ?? before)}>${canonicalJson(after["$ref"] ?? after)}`
    if (comparison.assumed.has(pair)) return true
    comparison.assumed.add(pair)
    const fit = fits(comparison, definition(comparison.before, before), definition(comparison.after, after))
    if (!fit) comparison.assumed.delete(pair)
    return fit
}

const values = (before: JsonSchema, after: JsonSchema): boolean => {
    const listed = (schema: JsonSchema) =>
        Array.isArray(schema["enum"]) ? schema["enum"] : "const" in schema ? [schema["const"]] : undefined
    const allowed = listed(after)
    if (allowed === undefined) return true
    const texts = new Set(allowed.map(canonicalJson))
    return listed(before)?.every((value) => texts.has(canonicalJson(value))) ?? false
}

const types = (before: JsonSchema, after: JsonSchema): boolean => {
    if (after["type"] === undefined) return true
    const allowed = [after["type"]].flat()
    if (before["type"] === undefined) return false
    return [before["type"]]
        .flat()
        .every((type) => allowed.includes(type) || (type === "integer" && allowed.includes("number")))
}

const bounds = (before: JsonSchema, after: JsonSchema): boolean =>
    Object.entries(after).every(([key, limit]) => {
        if (compared.has(key) || key.startsWith("x-umwelt-")) return true
        const own = before[key]
        if (lowerBounds.has(key)) return typeof own === "number" && typeof limit === "number" && own >= limit
        if (upperBounds.has(key)) return typeof own === "number" && typeof limit === "number" && own <= limit
        return same(own, limit)
    })

const objects = (comparison: Comparison, before: JsonSchema, after: JsonSchema): boolean => {
    const required = new Set(list(before["required"]))
    if (!list(after["required"]).every((key) => required.has(key))) return false
    if (after["properties"] === undefined && after["additionalProperties"] === undefined) return true
    const [own, target] = [record(before["properties"]), record(after["properties"])]
    const ownRest = isSchema(before["additionalProperties"]) ? before["additionalProperties"] : undefined
    const targetRest = isSchema(after["additionalProperties"]) ? after["additionalProperties"] : undefined
    const dropped = comparison.mode === "dropping"
    const into = (schema: unknown) => (targetRest === undefined ? dropped : fits(comparison, schema, targetRest))
    return (
        Object.entries(target).every(([key, schema]) =>
            Object.hasOwn(own, key)
                ? fits(comparison, own[key], schema)
                : ownRest === undefined || fits(comparison, ownRest, schema)
        ) &&
        Object.entries(own).every(([key, schema]) => Object.hasOwn(target, key) || into(schema)) &&
        (ownRest === undefined || into(ownRest))
    )
}

const arrays = (comparison: Comparison, before: JsonSchema, after: JsonSchema): boolean => {
    const [own, target] = [list(before["prefixItems"]), list(after["prefixItems"])]
    if (own.length !== target.length || !target.every((schema, index) => fits(comparison, own[index], schema)))
        return false
    return after["items"] === undefined || fits(comparison, before["items"] ?? true, after["items"])
}

/** Every value `before` admits is admitted by `after`, under the comparison's mode. */
function fits(comparison: Comparison, before: unknown, after: unknown): boolean {
    if (after === true || before === false) return true
    if (!isSchema(before) || !isSchema(after)) return same(before, after)
    if (before["$ref"] !== undefined || after["$ref"] !== undefined) return references(comparison, before, after)
    if (Array.isArray(before["anyOf"])) return before["anyOf"].every((member) => fits(comparison, member, after))
    if (Array.isArray(after["anyOf"])) {
        const { anyOf, ...rest } = after
        return fits(comparison, before, rest) && list(anyOf).some((member) => fits(comparison, before, member))
    }
    return (
        values(before, after) &&
        types(before, after) &&
        bounds(before, after) &&
        objects(comparison, before, after) &&
        arrays(comparison, before, after)
    )
}

const fitsAs = (mode: Mode, before: JsonSchema, after: JsonSchema) =>
    fits({ before, after, mode, assumed: new Set() }, before, after)

const dropsHistory = (before: JsonSchema, after: JsonSchema) =>
    before["x-umwelt-history"] === true && after["x-umwelt-history"] !== true

/**
 * New Type `safe`, removed Type `destructive`; equal forms only carry `migrate`, so `transforming`.
 * Otherwise `safe` when content fits unchanged, `destructive` when it fits after dropping fields or history, else `transforming`.
 */
export const kindOf = ({ before, after }: Step<JsonSchema | null, JsonSchema | null>): MigrationKind => {
    if (before === null) return "safe"
    if (after === null) return "destructive"
    if (same(before, after)) return "transforming"
    if (fitsAs("exact", before, after)) return dropsHistory(before, after) ? "destructive" : "safe"
    return fitsAs("dropping", before, after) ? "destructive" : "transforming"
}
