/** Relation resolution in `Umwelt.make`: per Type a payload codec where every Reference placeholder is the target's Identity. */
import { Schema, SchemaAST } from "effect"
import { changesOf } from "./chain/chain.ts"
import { declarationReasons } from "./chain/declarations.ts"
import type { AnyType } from "./declaration.ts"
import { formOf, relationsOf, type RelationLocation } from "./form.ts"
import { migrationHash, type JsonSchema, type Migration } from "./migration.ts"
import { placeholderOf, relationKey, slotOf, type RelationAnnotation } from "./relation.ts"

export interface ResolvedType {
    readonly type: AnyType
    readonly name: string
    /** Payload codec: Type side is Payload, relation positions hold the target's Identity. */
    readonly payload: Schema.Top
    /** JSON codec of the payload: encoded side is the stored JSON. */
    readonly json: Codec
    /** JSON codec per top-level payload field. */
    readonly fields: ReadonlyMap<string, Codec>
    /** Unique key field names, sorted; empty without unique key. */
    readonly uniqueKey: readonly string[]
    /** JSON codec of Identity; `undefined` without unique key. */
    readonly identity: Codec | undefined
    readonly immutable: boolean
    readonly history: boolean
    /** Top-level relation fields, the slots of `where` and include. */
    readonly slots: ReadonlyMap<string, RelationAnnotation>
    /** Serialized form, see Model. */
    readonly form: JsonSchema
    /** Relations at any depth, found in the form. */
    readonly relations: readonly RelationLocation[]
}

export interface ResolvedModel {
    /** Types as given to `make`, in order, repeats included. */
    readonly model: readonly AnyType[]
    /** By name; a repeated name keeps the last Type, Check reports the repeat. */
    readonly types: ReadonlyMap<string, ResolvedType>
    /** By Type value, as operations take it; keyed by `unknown` so any input value can be looked up. */
    readonly byType: ReadonlyMap<unknown, ResolvedType>
    readonly migrations: readonly Migration[]
    /** Chain's head: last Migration and its hash; `null` for an empty chain. */
    readonly head: { readonly id: string; readonly hash: string } | null
    /** Model in code equals the folded chain, see Model. */
    readonly current: boolean
    /** Model in code has no blocking reasons of its own, see Check. */
    readonly valid: boolean
}

type Rewrite = (ast: SchemaAST.AST) => SchemaAST.AST
type Codec = Schema.Codec<unknown, unknown>
type Resolver = { readonly identityOf: (name: string) => SchemaAST.Objects | undefined; readonly resolve: Rewrite }

/** Rebuilds structural nodes with rewritten children; leaves and unchanged nodes stay as they are. */
const rebuild = (ast: SchemaAST.AST, go: Rewrite): SchemaAST.AST => {
    if (SchemaAST.isObjects(ast)) return objects(ast, go)
    if (SchemaAST.isArrays(ast)) {
        const elements = SchemaAST.mapOrSame(ast.elements, go)
        const rest = SchemaAST.mapOrSame(ast.rest, go)
        if (elements === ast.elements && rest === ast.rest) return ast
        const { isMutable, annotations, checks, encoding, context, encodingChecks } = ast
        return new SchemaAST.Arrays(isMutable, elements, rest, annotations, checks, encoding, context, encodingChecks)
    }
    if (SchemaAST.isUnion(ast)) {
        const types = SchemaAST.mapOrSame(ast.types, go)
        if (types === ast.types) return ast
        const { options, annotations, checks, encoding, context, encodingChecks } = ast
        return new SchemaAST.Union(types, options, annotations, checks, encoding, context, encodingChecks)
    }
    if (SchemaAST.isSuspend(ast)) {
        const { thunk, annotations, checks, encoding, context } = ast
        return new SchemaAST.Suspend(() => go(thunk()), annotations, checks, encoding, context)
    }
    if (SchemaAST.isDeclaration(ast)) {
        const parameters = SchemaAST.mapOrSame(ast.typeParameters, go)
        if (parameters === ast.typeParameters) return ast
        const { run, annotations, checks, encoding, context, encodingChecks, encodingRun } = ast
        return new SchemaAST.Declaration(
            parameters,
            run,
            annotations,
            checks,
            encoding,
            context,
            encodingChecks,
            encodingRun
        )
    }
    return ast
}

const objects = (ast: SchemaAST.Objects, go: Rewrite): SchemaAST.Objects => {
    const properties = SchemaAST.mapOrSame(ast.propertySignatures, (property) => {
        const type = go(property.type)
        return type === property.type ? property : new SchemaAST.PropertySignature(property.name, type)
    })
    const indexes = SchemaAST.mapOrSame(ast.indexSignatures, (index) => {
        const type = go(index.type)
        return type === index.type ? index : new SchemaAST.IndexSignature(index.parameter, type)
    })
    if (properties === ast.propertySignatures && indexes === ast.indexSignatures) return ast
    const { annotations, checks, encoding, context, encodingChecks } = ast
    return new SchemaAST.Objects(properties, indexes, annotations, checks, encoding, context, encodingChecks)
}

/** Identity node at a relation position: keeps the placeholder's key context (optional, mutable) and its annotation. */
const atRelation = (identity: SchemaAST.Objects, placeholder: SchemaAST.AST, relation: RelationAnnotation) =>
    new SchemaAST.Objects(
        identity.propertySignatures,
        identity.indexSignatures,
        { ...identity.annotations, [relationKey]: relation },
        identity.checks,
        identity.encoding,
        placeholder.context,
        identity.encodingChecks
    )

const resolver = (types: ReadonlyMap<string, AnyType>): Resolver => {
    const identities = new Map<string, SchemaAST.Objects | undefined>()
    const resolving = new Set<string>()
    const identityOf = (name: string): SchemaAST.Objects | undefined => {
        const type = types.get(name)
        if (type === undefined || resolving.has(name) || Object.keys(type["~uniqueKey"]).length === 0) return undefined
        if (identities.has(name)) return identities.get(name)
        resolving.add(name)
        const identity = objects(Schema.Struct(type["~uniqueKey"]).ast, resolve)
        resolving.delete(name)
        identities.set(name, identity)
        return identity
    }
    const memo = new Map<SchemaAST.AST, SchemaAST.AST>()
    /** Unresolvable targets (unknown, without unique key, cyclic Identity) become an empty object; Check blocks them. */
    function resolve(ast: SchemaAST.AST): SchemaAST.AST {
        const known = memo.get(ast)
        if (known !== undefined) return known
        const relation = placeholderOf(ast)
        const resolved =
            relation === undefined
                ? rebuild(ast, resolve)
                : atRelation(identityOf(relation.target) ?? Schema.Struct({}).ast, ast, relation)
        memo.set(ast, resolved)
        return resolved
    }
    return { identityOf, resolve }
}

const resolveType = (type: AnyType, resolver: Resolver): ResolvedType => {
    const payload = Schema.make<Codec>(resolver.resolve(type.ast))
    const identity = resolver.identityOf(type.name)
    const uniqueKey = Object.keys(type["~uniqueKey"]).toSorted()
    const { immutable, history } = type["~mutability"]
    const form = formOf(payload, { uniqueKey, immutable: immutable === true, history: history === true })
    const fields = SchemaAST.isObjects(payload.ast) ? payload.ast.propertySignatures : []
    const slots = new Map<string, RelationAnnotation>()
    for (const [key, field] of Object.entries(type["~fields"])) {
        const slot = slotOf(field.ast)
        if (slot !== undefined) slots.set(key, slot)
    }
    return {
        type,
        name: type.name,
        payload,
        json: Schema.toCodecJson(payload),
        fields: new Map(
            fields.map((field) => [String(field.name), Schema.toCodecJson(Schema.make<Codec>(field.type))])
        ),
        uniqueKey,
        identity: identity === undefined ? undefined : Schema.toCodecJson(Schema.make<Codec>(identity)),
        immutable: immutable === true,
        history: history === true,
        slots,
        form,
        relations: relationsOf(form)
    }
}

/** Resolves every Type against the Model; never fails, Model errors are Check's. */
export const resolveModel = (model: readonly AnyType[], migrations: readonly Migration[]): ResolvedModel => {
    const named = new Map(model.map((type) => [type.name, type]))
    const shared = resolver(named)
    const types = new Map([...named].map(([name, type]) => [name, resolveType(type, shared)]))
    const last = migrations.at(-1)
    return {
        model,
        types,
        byType: new Map([...types.values()].map((resolved) => [resolved.type, resolved])),
        migrations,
        head: last === undefined ? null : { id: last.id, hash: migrationHash(last) },
        current: changesOf(types, migrations).length === 0,
        valid: declarationReasons({ model, types }).length === 0
    }
}
