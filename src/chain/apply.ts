/** Migrations over stored content: every Object and history entry of each touched Type. */
import { Effect, Schema, SchemaRepresentation, type JsonSchema as Json } from "effect"
import { canonicalJson, same } from "../canonical.ts"
import { MigrationFailed } from "../errors.ts"
import { isSchema, list, type JsonSchema, type Migration, type Step } from "../migration.ts"
import type { ResolvedModel } from "../resolve.ts"
import { umweltSql } from "../storage/tables.ts"
import { enforcing } from "../storage/unique.ts"

/** Stored JSON with its Object: `key` addresses the row, `identity` is the Object's stored identity column. */
type Row = { readonly key: string; readonly object: string; readonly identity: unknown; readonly payload: unknown }
/** Stored JSON in form after, or why not. */
type Fit = (row: Row) => Effect.Effect<unknown, string>

/** Stored payloads hold declared fields only: Effect's open structs are read closed, so decoding drops what the form drops. */
const closed = (schema: Json.JsonSchema): Json.JsonSchema =>
    schema["additionalProperties"] === true ? { ...schema, additionalProperties: false } : schema

/** Validates stored JSON against a form; succeeds with the JSON the form keeps. */
const decoderOf = (form: JsonSchema) => {
    const { $defs, ...schema } = form
    const definitions = Object.fromEntries(
        Object.entries(isSchema($defs) ? $defs : {}).filter((entry): entry is [string, JsonSchema] =>
            isSchema(entry[1])
        )
    )
    const document = { dialect: "draft-2020-12" as const, schema, definitions }
    const codec = SchemaRepresentation.fromJsonSchemaDocument(document, { onEnter: closed, patterns: "apply" })
    return Schema.decodeUnknownEffect(Schema.make<Schema.Codec<unknown, unknown>>(codec.ast))
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The decoder of form after, or why there is none; built once per step. */
const decoderOrCause = (after: JsonSchema) => {
    try {
        return decoderOf(after)
    } catch (error) {
        return `form after has no codec: ${messageOf(error)}`
    }
}

/** Identity as Write stores it: canonical object of the present unique key fields; `null` without unique key. */
const identityOf = (payload: unknown, key: readonly unknown[]) =>
    key.length === 0
        ? null
        : Object.fromEntries(
              key.flatMap((field) =>
                  typeof field === "string" && isSchema(payload) && field in payload ? [[field, payload[field]]] : []
              )
          )

/** Old stored JSON to new: `migrate` when present, then the form after; Identity must stay what is stored. */
const fitting = (after: JsonSchema, migrate: Step<unknown, unknown>["migrate"]): Fit => {
    const decode = decoderOrCause(after)
    const key = list(after["x-umwelt-unique-key"])
    return ({ identity, payload }) =>
        Effect.gen(function* () {
            if (typeof decode === "string") return yield* Effect.fail(decode)
            const migrated =
                typeof migrate === "function"
                    ? yield* Effect.try({
                          try: () => migrate(payload),
                          catch: (error) => `migrate threw: ${messageOf(error)}`
                      })
                    : payload
            const next = yield* Effect.mapError(
                decode(migrated),
                (error) => `result fails form after: ${error.message}`
            )
            if (canonicalJson(identityOf(next, key)) !== canonicalJson(identity))
                return yield* Effect.fail("Identity changed")
            return next
        })
}

const rewrite = <E, R>(
    rows: readonly Row[],
    fit: Fit,
    failed: (row: Row, cause: string) => MigrationFailed,
    update: (key: string, payload: unknown) => Effect.Effect<unknown, E, R>
) =>
    Effect.forEach(
        rows,
        (row) =>
            fit(row).pipe(
                Effect.mapError((cause) => failed(row, cause)),
                Effect.flatMap((payload) => (same(payload, row.payload) ? Effect.void : update(row.key, payload)))
            ),
        { discard: true }
    )

const applyStep = (
    model: ResolvedModel,
    migration: string,
    type: string,
    { before, after, migrate }: Step<JsonSchema | null, JsonSchema | null>
) =>
    Effect.gen(function* () {
        if (before === null || after === null) return
        const sql = yield* umweltSql
        if (before["x-umwelt-history"] === true && after["x-umwelt-history"] !== true)
            yield* sql`delete from umwelt_history where object in (select id from umwelt_object where type = ${type})`
        const fit = fitting(after, migrate)
        const failed = (row: Row, cause: string) => new MigrationFailed({ migration, type, object: row.object, cause })
        const objects = yield* sql<Row>`select id as key, id as object, identity, payload
            from umwelt_object where type = ${type}`
        yield* rewrite(objects, fit, failed, (key, payload) =>
            enforcing(
                type,
                model.types.get(type)?.unique ?? [],
                sql`update umwelt_object set payload = ${canonicalJson(payload)}::jsonb where id = ${key}`
            )
        )
        const history = yield* sql<Row>`select h.position::text as key, o.id as object, o.identity, h.payload
            from umwelt_history h join umwelt_object o on o.id = h.object where o.type = ${type}`
        yield* rewrite(
            history,
            fit,
            failed,
            (key, payload) =>
                sql`update umwelt_history set payload = ${canonicalJson(payload)}::jsonb where position = ${key}::bigint`
        )
    })

/**
 * Each touched Type of one Migration over its stored content; `safe` steps are proven, never trusted. Objects are
 * rewritten under the unique indexes in place, as Writes are: a result meeting another Object's values fails with
 * UniqueViolation.
 */
export const applyMigration = (model: ResolvedModel, migration: Migration) =>
    Effect.forEach(Object.entries(migration.types), ([type, step]) => applyStep(model, migration.id, type, step), {
        discard: true
    })
