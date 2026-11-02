import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt } from "../src/index.ts"
import { migrationHash } from "../src/migration.ts"
import { resolveModel } from "../src/resolve.ts"
import { appliedMigrations, requireModel } from "../src/storage/gate.ts"
import { ensureLayout } from "../src/storage/tables.ts"
import { chainOf } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"

const first = Umwelt.migration({ id: "a", parent: null, types: {} })
const model = resolveModel([], [first])

const insert = (type: string, identity: string | null) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`insert into umwelt_object (type, identity, payload) values (${type}, ${identity}::jsonb, '{}')`
    })

describe("storage", () => {
    layer(TestDatabase("storage"))((it) => {
        it.effect("gate reports ModelMismatch before Umwelt's tables exist", () =>
            Effect.gen(function* () {
                expect(yield* appliedMigrations).toEqual([])
                const error = yield* Effect.flip(requireModel(model))
                expect(error).toMatchObject({ _tag: "ModelMismatch", database: null, code: "a" })
            })
        )

        it.effect("brings the tables to the layout, idempotently", () =>
            Effect.gen(function* () {
                yield* ensureLayout
                yield* ensureLayout
                const sql = yield* SqlClient.SqlClient
                const tables = yield* sql<{ name: string }>`select table_name as name from information_schema.tables
                    where table_name like 'umwelt_%' order by table_name`
                expect(tables.map((table) => table.name)).toEqual(["umwelt_history", "umwelt_ledger", "umwelt_object"])
            })
        )

        it.effect("keeps Identity unique per Type, ignoring key order", () =>
            Effect.gen(function* () {
                yield* insert("Track", '{"slug":"night-drive","n":1}')
                yield* insert("Playlist", '{"slug":"night-drive","n":1}')
                yield* insert("Play", null)
                yield* insert("Play", null)
                const duplicate = yield* Effect.flip(insert("Track", '{"n":1,"slug":"night-drive"}'))
                expect(duplicate._tag).toBe("SqlError")
                yield* insert("Track", '{"slug":"night-drive","n":"1"}')
            })
        )

        it.effect("assigns Object IDs and keeps history beside its Object", () =>
            Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                const [object] = yield* sql<{ id: string }>`insert into umwelt_object (type, payload)
                    values ('Playlist', '{}') returning id`
                expect(object?.id).toMatch(/^[0-9a-f-]{36}$/u)
                yield* sql`insert into umwelt_history (object, payload) values (${object?.id ?? ""}, '{}')`
                yield* sql`delete from umwelt_object where id = ${object?.id ?? ""}`
                const [left] = yield* sql<{ count: number }>`select count(*)::int as count from umwelt_history`
                expect(left?.count).toBe(0)
            })
        )

        it.effect("gate passes only while Ledger's head is the chain's head", () =>
            Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                yield* sql`insert into umwelt_ledger (position, id, hash) values (1, 'a', 'sha256:other')`
                expect(yield* Effect.flip(requireModel(model))).toMatchObject({ database: "a", code: "a" })
                yield* sql`update umwelt_ledger set hash = ${migrationHash(first)} where id = 'a'`
                yield* requireModel(model)
                expect(yield* Effect.flip(requireModel(resolveModel([], [])))).toMatchObject({
                    database: "a",
                    code: null
                })
            })
        )

        it.effect("gate fails while Model in code is not what the chain folds to", () =>
            Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                const Tag = Umwelt.type("Tag", { name: Schema.String })
                const chain = chainOf([Tag])
                const [only] = chain
                if (only === undefined) return yield* Effect.die(new Error("empty chain"))
                yield* sql`update umwelt_ledger set id = ${only.id}, hash = ${migrationHash(only)} where position = 1`
                yield* requireModel(resolveModel([Tag], chain))
                const changed = Umwelt.type("Tag", { name: Schema.String, color: Schema.String })
                expect(yield* Effect.flip(requireModel(resolveModel([changed], chain)))).toMatchObject({
                    _tag: "ModelMismatch",
                    database: only.id,
                    code: only.id
                })
            })
        )
    })
})
