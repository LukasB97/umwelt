/** `Umwelt.make`: the Client, every operation and Type delegate wired to its module. */
import { Effect } from "effect"
import type { Client, Model, SqlExecutor } from "./api.ts"
import { check } from "./chain/check.ts"
import { modelKey } from "./chain/create.ts"
import { deploy } from "./chain/deploy.ts"
import { invalid, isRecord } from "./input.ts"
import type { Migration } from "./migration.ts"
import { promised } from "./promise.ts"
import { get } from "./read/get.ts"
import { query } from "./read/query.ts"
import { resolveModel, type ResolvedType } from "./resolve.ts"
import { remove } from "./write/delete.ts"
import { history } from "./write/history.ts"
import { write } from "./write/write.ts"

/** Delegate input with `type` bound; `type` inside it is a key the delegate types do not allow. */
const bind = (resolved: ResolvedType, input: unknown) =>
    isRecord(input) && !("type" in input)
        ? Effect.succeed({ ...input, type: resolved.type })
        : invalid(`${resolved.name} delegate takes an object without type`)

/** Never fails; Model errors are Check's. `migrations` is the chain `umwelt create` maintains. */
export const make = <const Ts extends Model>(types: Ts, options: { migrations: readonly Migration[] }): Client<Ts> => {
    const model = resolveModel(types, options.migrations)
    const operations = {
        write: (input: unknown) => write(model, input),
        get: (input: unknown) => get(model, input),
        query: (input: unknown) => query(model, input),
        delete: (input: unknown) => remove(model, input),
        history: (input: unknown) => history(model, input),
        check: () => check(model),
        deploy: () => deploy(model)
    }
    const delegate = (resolved: ResolvedType) => ({
        write: (input: unknown) =>
            Array.isArray(input)
                ? Effect.flatMap(
                      Effect.forEach(input, (entry) => bind(resolved, entry)),
                      operations.write
                  )
                : Effect.flatMap(bind(resolved, input), operations.write),
        get: (input: unknown) => Effect.flatMap(bind(resolved, input), operations.get),
        query: (input: unknown) => Effect.flatMap(bind(resolved, input), operations.query),
        delete: (input: unknown) => Effect.flatMap(bind(resolved, input), operations.delete),
        ...(resolved.history
            ? { history: (input: unknown) => Effect.flatMap(bind(resolved, input), operations.history) }
            : {})
    })
    const delegates = Object.fromEntries(
        [...model.types.values()].map((resolved) => [resolved.name, delegate(resolved)])
    )
    const face = { ...delegates, ...operations }
    const client = { ...face, [modelKey]: model, promise: (executor: SqlExecutor) => promised(face, executor) }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- operations take unknown input and are typed here, at the Client boundary
    return client as unknown as Client<Ts>
}
