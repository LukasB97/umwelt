/** Migration files: the chain `umwelt create` writes, and how a Migration is named by hash. */
import { sha256 } from "./canonical.ts"
import type { Simplify } from "./declaration.ts"

export type JsonSchema = { readonly [key: string]: unknown }

export const isSchema = (value: unknown): value is JsonSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value)

/** The value when it is a list, else empty. */
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

/** Stored-side TypeScript type for the small JSON Schema dialect Umwelt writes into migration files. */
export type FromJson<S> = S extends { readonly type: "string" }
    ? string
    : S extends { readonly type: "number" | "integer" }
      ? number
      : S extends { readonly type: "boolean" }
        ? boolean
        : S extends { readonly type: "null" }
          ? null
          : S extends { readonly type: "array"; readonly items: infer I }
            ? readonly FromJson<I>[]
            : S extends { readonly type: "object"; readonly properties: infer P }
              ? Simplify<FromJsonObject<P, S extends { readonly required: readonly (infer R)[] } ? R : never>>
              : S extends { readonly anyOf: readonly (infer U)[] }
                ? FromJson<U>
                : S extends { readonly enum: readonly (infer E)[] }
                  ? E
                  : unknown
type FromJsonObject<P, R> = { readonly [K in keyof P as K extends R ? K : never]: FromJson<P[K]> } & {
    readonly [K in keyof P as K extends R ? never : K]?: FromJson<P[K]>
}

/** Method type, so a step typed from its forms still fits `Migration`'s untyped steps. */
type Migrate<B, A> = { migrate(old: FromJson<B>): FromJson<A> }["migrate"]

export type Step<B, A> = {
    /** Form before; `null` when the Type is new. */
    before: B
    /** Form after; `null` when the Type is removed. */
    after: A
    /** On stored JSON, old in, new out. `create` writes `null` for transforming steps; Check blocks until it is filled. */
    migrate?: Migrate<B, A> | null
}

export interface Migration {
    readonly id: string
    /** Predecessor in the chain, `null` for the first. */
    readonly parent: { readonly id: string; readonly hash: string } | null
    readonly types: { readonly [type: string]: Step<JsonSchema | null, JsonSchema | null> }
}

/** One entry of the chain. `umwelt create` writes the whole file; developers fill `migrate`. */
export const migration = (definition: Migration): Migration => definition

/** One Type inside a migration; `old` and the result are typed from `before` and `after`. */
export const step = <const B extends JsonSchema | null, const A extends JsonSchema | null>(
    definition: Step<B, A>
): Step<B, A> => definition

/** Definition a local `$ref` names: a JSON Pointer token below `#/$defs/`, percent-encoded as URI fragment. */
export const definitionName = (reference: unknown): string | undefined =>
    typeof reference === "string" && reference.startsWith("#/$defs/")
        ? decodeURIComponent(reference.slice("#/$defs/".length)).replaceAll("~1", "/").replaceAll("~0", "~")
        : undefined

/** Hash naming a Migration in its child and in the Ledger: id, parent, and every form; `migrate` is not part of it. */
export const migrationHash = ({ id, parent, types }: Migration): string =>
    sha256({
        id,
        parent,
        types: Object.fromEntries(Object.entries(types).map(([name, { before, after }]) => [name, { before, after }]))
    })
