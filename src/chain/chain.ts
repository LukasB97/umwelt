/** The chain folded into forms per Type, its difference to the Model, and how it breaks. See Model. */
import { canonicalJson, same } from "../canonical.ts"
import type { BlockingReason } from "../errors.ts"
import { migrationHash, type JsonSchema, type Migration } from "../migration.ts"

export type TypeChange = {
    readonly type: string
    readonly before: JsonSchema | null
    readonly after: JsonSchema | null
}

const apply = (forms: Map<string, JsonSchema>, migration: Migration) => {
    for (const [type, { after }] of Object.entries(migration.types)) {
        if (after === null) forms.delete(type)
        else forms.set(type, after)
    }
}

/** The Model as the chain knows it: form per Type name. */
export const fold = (migrations: readonly Migration[]): ReadonlyMap<string, JsonSchema> => {
    const forms = new Map<string, JsonSchema>()
    for (const migration of migrations) apply(forms, migration)
    return forms
}

/** Types whose form in code differs from the folded chain: Model order first, then Types only the chain has. */
export const changesOf = (
    types: ReadonlyMap<string, { readonly form: JsonSchema }>,
    migrations: readonly Migration[]
): readonly TypeChange[] => {
    const chain = fold(migrations)
    return [...new Set([...types.keys(), ...chain.keys()])]
        .map((type) => ({ type, before: chain.get(type) ?? null, after: types.get(type)?.form ?? null }))
        .filter(({ before, after }) => !same(before, after))
}

const link = (migration: Migration | undefined) =>
    migration === undefined ? null : { id: migration.id, hash: migrationHash(migration) }

const continues = (forms: ReadonlyMap<string, JsonSchema>, migration: Migration) =>
    Object.entries(migration.types).every(([type, { before }]) => same(before, forms.get(type) ?? null))

/**
 * `fork`: a parent named by an earlier Migration too. `chainBroken`: a parent that is not the previous Migration by id and hash,
 * or a form before that is not what the chain folds to there.
 */
export const chainReasons = (migrations: readonly Migration[]): readonly BlockingReason[] => {
    const forms = new Map<string, JsonSchema>()
    const parents = new Set<string>()
    const reasons: BlockingReason[] = []
    for (const [index, migration] of migrations.entries()) {
        const parent = canonicalJson(migration.parent)
        if (parents.has(parent)) reasons.push({ kind: "fork", migration: migration.id })
        else if (!same(migration.parent, link(migrations[index - 1])) || !continues(forms, migration))
            reasons.push({ kind: "chainBroken", migration: migration.id })
        parents.add(parent)
        apply(forms, migration)
    }
    return reasons
}
