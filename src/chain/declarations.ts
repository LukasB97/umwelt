/** Blocking reasons of the Model itself; Type, Relations, and Query own each trigger. */
import { Schema, SchemaAST } from "effect"
import { canonicalJson } from "../canonical.ts"
import type { ReservedTypeName } from "../declaration.ts"
import type { BlockingReason } from "../errors.ts"
import { isSchema, list, type JsonSchema } from "../migration.ts"
import type { ResolvedModel, ResolvedType } from "../resolve.ts"
import { domainsOf, shapeOf, type Domain } from "../values.ts"

const reservedTypeNames: ReadonlySet<string> = new Set<ReservedTypeName>([
    "write",
    "get",
    "query",
    "delete",
    "history",
    "check",
    "deploy",
    "promise"
])
const reservedFieldNames: ReadonlySet<string> = new Set(["AND", "OR", "NOT"])

const values = (value: unknown): readonly unknown[] => (isSchema(value) ? Object.values(value) : [])

const subschemas = (schema: JsonSchema): readonly unknown[] => [
    ...values(schema["properties"]),
    ...values(schema["$defs"]),
    schema["items"],
    schema["additionalProperties"],
    ...list(schema["anyOf"]),
    ...list(schema["oneOf"]),
    ...list(schema["allOf"]),
    ...list(schema["prefixItems"])
]

/** A position exported as `{}`: no JSON Schema, nothing Umwelt could check or migrate. */
const opaque = (schema: unknown): boolean =>
    isSchema(schema) && (Object.keys(schema).length === 0 || subschemas(schema).some(opaque))

const children = (ast: SchemaAST.AST): readonly SchemaAST.AST[] => {
    if (SchemaAST.isObjects(ast))
        return [...ast.propertySignatures.map((field) => field.type), ...ast.indexSignatures.map((index) => index.type)]
    if (SchemaAST.isArrays(ast)) return [...ast.elements, ...ast.rest]
    if (SchemaAST.isUnion(ast)) return ast.types
    if (SchemaAST.isSuspend(ast)) return [ast.thunk()]
    return SchemaAST.isDeclaration(ast) ? ast.typeParameters : []
}

/** `Schema.optional` and `Schema.UndefinedOr` hold `undefined`, which JSON has not. */
const holdsUndefined = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): boolean => {
    if (seen.has(ast)) return false
    seen.add(ast)
    return SchemaAST.isUndefined(ast) || children(ast).some((child) => holdsUndefined(child, seen))
}

const stored = (ast: SchemaAST.AST) => canonicalJson(Schema.toJsonSchemaDocument(Schema.make(ast)))

const validKey = ({ type }: ResolvedType) =>
    Object.entries(type["~uniqueKey"]).every(([key, schema]) => {
        const field = type["~fields"][key]
        return field !== undefined && stored(field.ast) === stored(schema.ast)
    })

/**
 * `AND`, `OR`, `NOT` as field names in any struct a where reads, at their path like `steps[].AND`: fields of structs and
 * elements of arrays, as `shapeOf` reads them. A domain whose schemas were all entered on the path is not entered
 * again, so recursion ends.
 */
const reservedPaths = (domain: Domain, path: string, entered: ReadonlySet<SchemaAST.AST>): readonly string[] => {
    if (domain.encodings.every((ast) => entered.has(ast))) return []
    const inner = new Set([...entered, ...domain.encodings])
    const shape = shapeOf(domain)
    if (shape.kind === "array") return reservedPaths(shape.elements, `${path}[]`, inner)
    if (shape.kind === "other") return []
    return [...domainsOf(shape.members)].flatMap(([name, field]) => {
        const at = path === "" ? name : `${path}.${name}`
        return [...(reservedFieldNames.has(name) ? [at] : []), ...reservedPaths(field, at, inner)]
    })
}

const when = (condition: boolean, reason: BlockingReason): readonly BlockingReason[] => (condition ? [reason] : [])

/** What the Model's own checks read: Types as given, and resolved by name. */
type Declared = Pick<ResolvedModel, "model" | "types">

const relationReasons = (model: Declared, resolved: ResolvedType): readonly BlockingReason[] =>
    resolved.relations.flatMap(({ field, target }) => {
        const uniqueKey = model.types.get(target)?.uniqueKey
        return [
            ...when(uniqueKey === undefined, { kind: "unknownRelationTarget", type: resolved.name, field, target }),
            ...when(uniqueKey?.length === 0, {
                kind: "relationTargetWithoutUniqueKey",
                type: resolved.name,
                field,
                target
            })
        ]
    })

/** One payload location holds references to one target Type, or `null`, see Relations. */
const ambiguousReasons = ({ name, relations }: ResolvedType): readonly BlockingReason[] =>
    [...new Set(relations.filter(({ ambiguous }) => ambiguous).map(({ field }) => field))].map(
        (field): BlockingReason => ({ kind: "ambiguousRelation", type: name, field })
    )

/** Relation fields inside recursive schema parts: later, not now. */
const recursiveReasons = ({ name, relations }: ResolvedType): readonly BlockingReason[] =>
    relations
        .filter(({ recursive }) => recursive)
        .map(({ field }): BlockingReason => ({ kind: "recursiveRelation", type: name, field }))

const typeReasons = (model: Declared, resolved: ResolvedType): readonly BlockingReason[] => {
    const { name, type } = resolved
    const { immutable, history }: { readonly immutable?: boolean; readonly history?: boolean } = type["~mutability"]
    const repeated = model.model.filter((other) => other.name === name).length > 1
    return [
        ...when(holdsUndefined(type.ast, new Set()) || opaque(resolved.form), { kind: "invalidSchema", type: name }),
        ...when(!validKey(resolved), { kind: "invalidUniqueKey", type: name }),
        ...when(reservedTypeNames.has(name), { kind: "reservedTypeName", type: name }),
        ...when(repeated, { kind: "duplicateTypeName", type: name }),
        ...reservedPaths({ encodings: [resolved.payload.ast], optional: false }, "", new Set()).map(
            (field): BlockingReason => ({ kind: "reservedFieldName", type: name, field })
        ),
        ...relationReasons(model, resolved),
        ...ambiguousReasons(resolved),
        ...recursiveReasons(resolved),
        ...when(immutable === true && history === true, { kind: "immutableWithHistory", type: name })
    ]
}

/** Per Type in Model order; a repeated name is checked once, as the Client keeps it. */
export const declarationReasons = (model: Declared): readonly BlockingReason[] =>
    [...model.types.values()].flatMap((resolved) => typeReasons(model, resolved))
