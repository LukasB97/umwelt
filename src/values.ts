/**
 * What payload schemas hold, as `where`, `orderBy`, and Check read them. A field's domain is its schemas across the
 * struct members holding it, read together like one union: what it takes follows from what they hold together.
 */
import { SchemaAST } from "effect"
import { isRecord } from "./input.ts"
import type { ResolvedType } from "./resolve.ts"

export type Kind = "number" | "string" | "date"
/** Domain of a field or element: its schemas, each one encoding, and whether the value may be absent. */
export type Domain = { readonly encodings: readonly SchemaAST.AST[]; readonly optional: boolean }
/**
 * What a domain's values hold together: structs, arrays, or other values. JSON null fits every shape; records, structs
 * and arrays with an encoding, and declarations are other values.
 */
export type Shape =
    | { readonly kind: "struct"; readonly members: readonly SchemaAST.Objects[] }
    | { readonly kind: "array"; readonly elements: Domain }
    | { readonly kind: "other" }

const distinct = <A>(items: readonly A[]): readonly A[] => [...new Set(items)]

/** The struct an Object's payload is. */
export const payloadOf = (type: ResolvedType): readonly SchemaAST.Objects[] =>
    SchemaAST.isObjects(type.payload.ast) ? [type.payload.ast] : []

/** Fields across struct members, each optional when some member lacks it or declares it optional. */
export const domainsOf = (members: readonly SchemaAST.Objects[]): ReadonlyMap<string, Domain> => {
    const signatures = members.flatMap((member) => member.propertySignatures)
    return new Map(
        distinct(signatures.map(({ name }) => String(name))).map((name) => {
            const found = signatures.filter((signature) => String(signature.name) === name).map(({ type }) => type)
            const optional = found.length < members.length || found.some(SchemaAST.isOptional)
            return [name, { encodings: distinct(found), optional }]
        })
    )
}

type Member = SchemaAST.Objects | SchemaAST.Arrays | "other"

/** Members of a schema through unions and `Schema.suspend`, followed once per path; null adds none. */
const membersOf = (ast: SchemaAST.AST, entered: ReadonlySet<SchemaAST.AST>): readonly Member[] => {
    if (SchemaAST.isNull(ast)) return []
    if (ast.encoding !== undefined) return ["other"]
    if (SchemaAST.isSuspend(ast)) return entered.has(ast) ? [] : membersOf(ast.thunk(), new Set([...entered, ast]))
    if (SchemaAST.isUnion(ast)) return ast.types.flatMap((member) => membersOf(member, entered))
    if (SchemaAST.isObjects(ast)) return ast.indexSignatures.length === 0 ? [ast] : ["other"]
    return SchemaAST.isArrays(ast) ? [ast] : ["other"]
}

export const shapeOf = (domain: Domain): Shape => {
    const members = domain.encodings.flatMap((ast) => membersOf(ast, new Set()))
    const structs = members.filter((member) => member !== "other" && SchemaAST.isObjects(member))
    if (structs.length > 0 && structs.length === members.length) return { kind: "struct", members: distinct(structs) }
    const arrays = members.filter((member) => member !== "other" && SchemaAST.isArrays(member))
    if (arrays.length === 0 || arrays.length < members.length) return { kind: "other" }
    const elements = arrays.flatMap((array) => [...array.elements, ...array.rest])
    return { kind: "array", elements: { encodings: distinct(elements), optional: false } }
}

const isDate = (ast: SchemaAST.Declaration) => {
    const representation = ast.annotations?.["representation"]
    return isRecord(representation) && representation["id"] === "effect/schema/Date"
}

const valueKinds = (values: readonly unknown[]): readonly Kind[] | undefined =>
    values.every((value) => typeof value === "string" || typeof value === "number")
        ? values.map((value) => (typeof value === "string" ? "string" : "number"))
        : undefined

/** Kinds of the values a schema holds; `Schema.suspend` is followed once per path. */
const kinds = (ast: SchemaAST.AST, entered: ReadonlySet<SchemaAST.AST>): readonly Kind[] | undefined => {
    if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) return ["string"]
    if (SchemaAST.isNumber(ast)) return ["number"]
    if (SchemaAST.isLiteral(ast)) return valueKinds([ast.literal])
    if (SchemaAST.isEnum(ast)) return valueKinds(ast.enums.map(([, value]) => value))
    if (SchemaAST.isNull(ast)) return []
    if (SchemaAST.isDeclaration(ast)) return isDate(ast) ? ["date"] : undefined
    if (SchemaAST.isSuspend(ast)) return entered.has(ast) ? undefined : kinds(ast.thunk(), new Set([...entered, ast]))
    if (!SchemaAST.isUnion(ast)) return undefined
    const members = ast.types.map((member) => kinds(member, entered))
    return members.every((member) => member !== undefined) ? members.flat() : undefined
}

/**
 * Kinds of the non-null values of schemas, each number, string, or Date; `undefined` when some value is none of them.
 * Decides what `lt`, `gt`, and `contains` take, and what `orderBy` sorts by.
 */
export const kindsOf = (encodings: readonly SchemaAST.AST[]): ReadonlySet<Kind> | undefined => {
    const found = encodings.map((ast) => kinds(SchemaAST.toType(ast), new Set()))
    return found.every((each) => each !== undefined) ? new Set(found.flat()) : undefined
}

/** Fields holding numbers only: they sort and compare by numeric value, whatever their stored form, see Query. */
export const isNumeric = (kinds: ReadonlySet<Kind> | undefined) => kinds?.size === 1 && kinds.has("number")
