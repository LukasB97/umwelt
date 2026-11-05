/** Serialized form of a Type: the stored side as JSON Schema Draft 2020-12 with Umwelt annotations, as Migrations hold it. */
import { Schema } from "effect"
import { canonicalJson } from "./canonical.ts"
import type { RelationMode } from "./declaration.ts"
import { definitionName, isSchema, list, type JsonSchema } from "./migration.ts"
import { isRelationAnnotation, relationKey } from "./relation.ts"

const isUmweltKey = (key: string) => key.startsWith("x-umwelt-")

/** Keywords Effect emits from documentation annotations; they describe, never constrain. */
const annotationOnly = new Set(["title", "description", "default", "examples", "readOnly", "writeOnly"])
const schemaMaps = new Set(["properties", "$defs", "patternProperties", "dependentSchemas"])
const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"])
const schemaValues = new Set([
    "items",
    "additionalProperties",
    "not",
    "contains",
    "propertyNames",
    "if",
    "then",
    "else",
    "unevaluatedItems",
    "unevaluatedProperties",
    "contentSchema"
])

const mapValues = (record: JsonSchema, map: (value: unknown) => unknown): JsonSchema =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))

const keyword = (key: string, value: unknown): unknown => {
    if (schemaMaps.has(key) && isSchema(value)) return mapValues(value, structure)
    if (schemaLists.has(key) && Array.isArray(value)) return value.map(structure)
    if (key === "required" && Array.isArray(value)) return value.map(String).toSorted()
    return schemaValues.has(key) ? structure(value) : value
}

/**
 * Schema without annotation-only keywords at any depth, `required` sorted:
 * documentation changes and field order leave the form, and its hash, alone.
 */
const structureOf = (schema: JsonSchema): JsonSchema =>
    Object.fromEntries(
        Object.entries(schema)
            .filter(([key]) => !annotationOnly.has(key))
            .map(([key, value]) => [key, keyword(key, value)])
    )

function structure(value: unknown): unknown {
    return isSchema(value) ? structureOf(value) : value
}

/** Form of a resolved payload codec: `$defs` beside the root when shared definitions exist; options as root annotations. */
export const formOf = (
    payload: Schema.Top,
    options: {
        readonly uniqueKey: readonly string[]
        readonly unique: readonly object[]
        readonly immutable: boolean
        readonly history: boolean
    }
): JsonSchema => {
    const document = Schema.toJsonSchemaDocument(payload, { includeAnnotationKey: isUmweltKey })
    return {
        ...structureOf(document.schema),
        ...(Object.keys(document.definitions).length > 0 ? { $defs: mapValues(document.definitions, structure) } : {}),
        ...(options.uniqueKey.length > 0 ? { "x-umwelt-unique-key": options.uniqueKey.toSorted() } : {}),
        ...(options.unique.length > 0 ? { "x-umwelt-unique": options.unique } : {}),
        ...(options.immutable ? { "x-umwelt-immutable": true } : {}),
        ...(options.history ? { "x-umwelt-history": true } : {})
    }
}

/** Where a relation sits in the payload. */
export type RelationLocation = {
    /** RelationPath of the relation field, like `track`, `tracks`, or `entries[].track`. */
    readonly field: string
    /**
     * Postgres jsonpath selecting every Identity the field holds, like `$."entries"[*]."track"` or `$."tracks"[*]`,
     * each followed by a filter dropping `null`: inside `Schema.NullOr`, `null` holds no reference.
     */
    readonly path: string
    readonly target: string
    readonly mode: RelationMode
    /** Inside a recursive schema part, so found only down to the first recursion: Check's `recursiveRelation`. */
    readonly recursive: boolean
    /** Some union branch puts another Type or any value but `null` where it sits: Check's `ambiguousRelation`. */
    readonly ambiguous: boolean
}

type Found = { readonly location: Omit<RelationLocation, "recursive" | "ambiguous">; readonly at: string }

type Walk = {
    readonly definitions: JsonSchema
    /** Definitions entered on the way here. */
    readonly seen: ReadonlySet<string>
    readonly found: (Found & { readonly within: ReadonlySet<string> })[]
    /** Definitions reaching themselves. */
    readonly recursive: Set<string>
    /** What the schema puts at each jsonpath, over all union branches: `relation:<target>`, `null`, `array`, or `value`. */
    readonly values: Map<string, Set<string>>
}

const member = (field: string, key: string) => (field === "" ? key : `${field}.${key}`)

/** What a schema puts at its position; `undefined` for pure composition, like `anyOf` or `$ref`, whose parts say. */
const valueOf = (schema: JsonSchema) => {
    if (!("type" in schema) && !("enum" in schema) && !("const" in schema)) return undefined
    return schema["type"] === "null" || schema["type"] === "array" ? schema["type"] : "value"
}

const record = (context: Walk, path: string, value: string | undefined) => {
    if (value !== undefined) context.values.set(path, new Set([...(context.values.get(path) ?? []), value]))
}

const walk = (context: Walk, schema: unknown, field: string, path: string): void => {
    if (!isSchema(schema)) return
    const relation = schema[relationKey]
    if (isRelationAnnotation(relation)) {
        const owner = relation.card === "many" ? field.replace(/\[\]$/u, "") : field
        const location = {
            field: owner,
            path: `${path} ? (@.type() != "null")`,
            target: relation.target,
            mode: relation.mode
        }
        record(context, path, `relation:${relation.target}`)
        context.found.push({ location, at: path, within: context.seen })
        return
    }
    record(context, path, valueOf(schema))
    const reference = definitionName(schema["$ref"])
    if (reference !== undefined && context.seen.has(reference)) context.recursive.add(reference)
    else if (reference !== undefined)
        walk({ ...context, seen: new Set([...context.seen, reference]) }, context.definitions[reference], field, path)
    const properties = isSchema(schema["properties"]) ? Object.entries(schema["properties"]) : []
    for (const [key, value] of properties) walk(context, value, member(field, key), `${path}.${JSON.stringify(key)}`)
    walk(context, schema["items"], `${field}[]`, `${path}[*]`)
    walk(context, schema["additionalProperties"], member(field, "*"), `${path}.*`)
    for (const key of ["anyOf", "oneOf", "allOf"])
        for (const value of list(schema[key])) walk(context, value, field, path)
    for (const [index, value] of list(schema["prefixItems"]).entries())
        walk(context, value, `${field}[${index}]`, `${path}[${index}]`)
}

/**
 * Only references to its target, or `null`, where a relation sits; inside an array, only arrays or `null` where the array
 * sits, since jsonpath in lax mode reads any other value there as one element.
 */
const ambiguous = ({ values }: Walk, { location, at }: Found) => {
    const only = (path: string, allowed: readonly string[]) =>
        [...(values.get(path) ?? [])].every((value) => allowed.includes(value))
    const element = /\[(?:\*|\d+)\]$/u
    return (
        !only(at, [`relation:${location.target}`, "null"]) ||
        (element.test(at) && !only(at.replace(element, ""), ["array", "null"]))
    )
}

/**
 * Every relation in a form, at any depth, found through its `x-umwelt-relation` annotation, each once.
 * Union branches at one location are all kept, each marked `ambiguous` when other branches put other values there.
 * A recursive definition is entered once per path, so relations inside it are found down to its first recursion only,
 * and marked `recursive`: below some definition on their way that reaches itself.
 */
export const relationsOf = (form: JsonSchema): readonly RelationLocation[] => {
    const definitions = isSchema(form["$defs"]) ? form["$defs"] : {}
    const context: Walk = { definitions, seen: new Set(), found: [], recursive: new Set(), values: new Map() }
    walk(context, form, "", "$")
    const found = context.found.map((entry) => ({
        ...entry.location,
        recursive: [...entry.within].some((definition) => context.recursive.has(definition)),
        ambiguous: ambiguous(context, entry)
    }))
    return [...new Map(found.map((location) => [canonicalJson(location), location])).values()]
}
