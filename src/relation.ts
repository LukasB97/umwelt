/** Runtime of relation declarations: placeholders with `x-umwelt-relation`, and relation fields as values. */
import { Schema, SchemaAST } from "effect"
import type { AnyType, Cardinality, Reference, Refinement, Relation, RelationMode } from "./declaration.ts"

export const relationKey = "x-umwelt-relation"

const RelationAnnotation = Schema.Struct({
    target: Schema.String,
    card: Schema.Literals(["one", "many"]),
    mode: Schema.Literals(["strict", "sparse"])
})
export type RelationAnnotation = typeof RelationAnnotation.Type
export const isRelationAnnotation = Schema.is(RelationAnnotation)

const isReference = <N extends string>(input: unknown): input is Reference<N> =>
    typeof input === "object" && input !== null && !Array.isArray(input)

const reference = <N extends string>(target: N, card: Cardinality, mode: RelationMode) =>
    Schema.declare(isReference<N>, { [relationKey]: { target, card, mode } })

const oneRelation = <N extends string, M extends RelationMode>(target: N, mode: M): Relation<N, "one", M> =>
    Object.assign(reference(target, "one", mode), { "~mode": mode, sparse: () => oneRelation(target, "sparse") })

const manyRelation = <N extends string, M extends RelationMode>(target: N, mode: M): Relation<N, "many", M> =>
    Object.assign(Schema.Array(reference(target, "many", mode)), {
        "~mode": mode,
        sparse: () => manyRelation(target, "sparse")
    })

/** Field holding Identity of one target. */
export const one = <const N extends string>(target: N): Relation<N, "one", "strict"> => oneRelation(target, "strict")
/** Field holding list of target Identities. */
export const many = <const N extends string>(target: N): Relation<N, "many", "strict"> => manyRelation(target, "strict")

/** The relation annotation of an unresolved placeholder node, if the node is one. */
export const placeholderOf = (ast: SchemaAST.AST): RelationAnnotation | undefined => {
    const annotation = SchemaAST.isDeclaration(ast) ? ast.annotations?.[relationKey] : undefined
    return isRelationAnnotation(annotation) ? annotation : undefined
}

/** Top-level relation slot of a declared field: `one` placeholder, or array of placeholders for `many`, also inside `Schema.NullOr`. */
export const slotOf = (ast: SchemaAST.AST): RelationAnnotation | undefined => {
    if (SchemaAST.isUnion(ast)) {
        const [member, ...more] = ast.types.filter((type) => !SchemaAST.isNull(type))
        return member === undefined || more.length > 0 ? undefined : slotOf(member)
    }
    const [item] = SchemaAST.isArrays(ast) && ast.elements.length === 0 ? ast.rest : []
    const many = item === undefined ? undefined : placeholderOf(item)
    if (many !== undefined) return { ...many, card: "many" }
    const single = placeholderOf(ast)
    return single === undefined ? undefined : { ...single, card: "one" }
}

const relationField = (source: AnyType, field: string, target: string, refinement: Refinement) => ({
    "~source": source,
    "~field": field,
    "~target": target,
    "~include": refinement.include ?? {},
    "~refinement": refinement,
    where: (where: unknown) => relationField(source, field, target, { ...refinement, where }),
    orderBy: (orderBy: unknown) => relationField(source, field, target, { ...refinement, orderBy }),
    take: (take: number) => relationField(source, field, target, { ...refinement, take }),
    skip: (skip: number) => relationField(source, field, target, { ...refinement, skip }),
    cursor: (cursor: unknown) => relationField(source, field, target, { ...refinement, cursor }),
    include: (include: unknown) => relationField(source, field, target, { ...refinement, include })
})

/** The field schema of a relation slot, also a RelationField of its Type: `Play.fields.track`. */
export const edge = (source: AnyType, field: string, schema: Schema.Constraint, target: string): Schema.Top =>
    Object.defineProperties(
        Schema.make<Schema.Top>(schema.ast),
        Object.getOwnPropertyDescriptors(relationField(source, field, target, {}))
    )
