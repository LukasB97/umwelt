/**
 * Unique constraints of a Type, see Type: the declared shape, its place in the form, and the partial unique index
 * enforcing each one on `umwelt_object`.
 */
import { canonicalJson, sha256 } from "./canonical.ts"
import { isSchema } from "./migration.ts"

/** One constraint as declared: `true` leaves name the values unique together, nested objects are paths. */
export type UniqueFields = { readonly [key: string]: true | UniqueFields }

export type UniqueIndex = {
    /** The constraint as declared. */
    readonly fields: UniqueFields
    /** Name derived from the definition, so a changed constraint, or a changed way to enforce it, gets another name. */
    readonly name: string
    /** `create unique index` statement. */
    readonly definition: string
}

/** Postgres allows 32 columns per index. */
export const maxUniqueFields = 32

/** Own keys only, also `__proto__`: entries make the object, assignment would not. */
const fieldsOf = (value: unknown): UniqueFields | undefined => {
    if (!isSchema(value) || Object.keys(value).length === 0) return undefined
    const entries = Object.entries(value).map(([key, item]) => [key, item === true ? true : fieldsOf(item)] as const)
    return entries.every((entry): entry is readonly [string, true | UniqueFields] => entry[1] !== undefined)
        ? Object.fromEntries(entries)
        : undefined
}

/**
 * Declared constraints in canonical order, each once, as the form holds them; `undefined` when the declaration is no
 * list of non-empty objects with `true` leaves, Check's `invalidUnique`.
 */
export const uniqueOf = (declared: unknown): readonly UniqueFields[] | undefined => {
    if (!Array.isArray(declared)) return undefined
    const constraints: readonly unknown[] = declared
    const parsed = constraints.map(fieldsOf)
    if (!parsed.every((fields): fields is UniqueFields => fields !== undefined)) return undefined
    const texts = new Map(parsed.map((fields) => [canonicalJson(fields), fields]))
    return [...texts.entries()].toSorted(([left], [right]) => (left < right ? -1 : 1)).map(([, fields]) => fields)
}

/** Paths of the `true` leaves, keys sorted at every depth. */
export const pathsOf = (fields: UniqueFields, prefix: readonly string[] = []): readonly (readonly string[])[] =>
    Object.keys(fields)
        .toSorted()
        .flatMap((key) => {
            const item = fields[key]
            if (item === undefined) return []
            return item === true ? [[...prefix, key]] : pathsOf(item, [...prefix, key])
        })

/** SQL string literal; Umwelt's index definitions assume `standard_conforming_strings`, as the identity index does. */
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

/**
 * One index column per path: JSON null and absent become SQL NULL, which never collides; the value is hashed like
 * Identity, so values of any size fit a btree entry.
 */
const column = (path: readonly string[]) => {
    const value = `payload${path.map((key) => ` -> ${literal(key)}`).join("")}`
    return `sha256(replace(nullif(${value}, 'null'::jsonb)::text, '\\', '\\\\')::bytea)`
}

/** Hex digits of the definition's hash in an index name: 160 bits, and the name stays inside Postgres' 63 bytes. */
const hashDigits = 40

/** Partial unique index over one Type's rows; Write and Deploy map its violations to UniqueViolation by name. */
export const uniqueIndex = (type: string, fields: UniqueFields): UniqueIndex => {
    const body = `on umwelt_object (${pathsOf(fields).map(column).join(", ")}) where type = ${literal(type)}`
    const hash = sha256(body).slice("sha256:".length)
    const name = `umwelt_unique_${hash.slice(0, hashDigits)}`
    return { fields, name, definition: `create unique index ${name} ${body}` }
}
