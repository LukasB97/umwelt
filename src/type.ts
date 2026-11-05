/** Runtime of `Umwelt.type`: an Effect Struct carrying name, ObjectId codec, unique key, unique constraints, options, and relation edges. */
import { Schema } from "effect"
import type { Fields, Mutability, ObjectId, ReservedTypeName, SubFields, Type, Unique } from "./declaration.ts"
import { edge, slotOf } from "./relation.ts"

const isObjectId = <T>(input: unknown): input is ObjectId<T> => typeof input === "string"

/** Declares Type from Effect fields. */
export const type = <
    const N extends string,
    const F extends Fields,
    const UK extends SubFields<F> & Fields = {},
    const M extends Mutability = {}
>(
    name: N extends ReservedTypeName ? never : N,
    fields: F,
    options?: { uniqueKey?: Schema.Struct<UK>; unique?: readonly Unique<F>[] } & M
): Type<N, F, UK, M> => {
    const struct = Object.defineProperties(Schema.Struct(fields), {
        name: { value: name },
        ObjectId: { value: Schema.declare(isObjectId) },
        "~fields": { value: fields },
        "~uniqueKey": { value: options?.uniqueKey?.fields ?? {} },
        "~unique": { value: options?.unique ?? [] },
        "~mutability": { value: { immutable: options?.immutable === true, history: options?.history === true } }
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- members are defined above, relation edges below
    const self = struct as unknown as Type<N, F, UK, M>
    const edges: Record<string, Schema.Constraint> = {}
    for (const [key, field] of Object.entries(fields)) {
        const slot = slotOf(field.ast)
        if (slot !== undefined) edges[key] = edge(self, key, field, slot.target)
    }
    Object.defineProperty(struct, "fields", { value: { ...fields, ...edges } })
    return self
}
