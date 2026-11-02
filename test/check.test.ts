import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { changeOf } from "../src/chain/check.ts"
import type { Fields } from "../src/declaration.ts"
import { Umwelt } from "../src/index.ts"
import { migrationHash, type Migration } from "../src/migration.ts"
import { resolveModel } from "../src/resolve.ts"
import { ensureLayout } from "../src/storage/tables.ts"
import { chainOf, extend, insertObject, reset, tableExists } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"
import { EscapedPart, Part } from "./model.ts"

const Track = (fields: Fields = {}, uniqueKey: Fields = { slug: Schema.String }) =>
    Umwelt.type("Track", { slug: Schema.String, ...fields }, { uniqueKey: Schema.Struct(uniqueKey) })
const Tag = Umwelt.type("Tag", { name: Schema.String })

/** Ledger as Deploy writes it, for the first `count` Migrations of the chain. */
const applied = (chain: readonly Migration[], count: number) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* ensureLayout
        for (const [index, migration] of chain.slice(0, count).entries())
            yield* sql`insert into umwelt_ledger (position, id, hash) values (${index + 1}, ${migration.id}, ${migrationHash(migration)})`
    })

describe("Check", () => {
    layer(TestDatabase("check"))((it) => {
        it.effect("before the first Deploy: everything pending, nothing stored, nothing created", () =>
            Effect.gen(function* () {
                yield* reset
                const chain = chainOf([Track(), Tag], [Track({ title: Schema.String }), Tag])
                const change = yield* Umwelt.make([Track({ title: Schema.String }), Tag], {
                    migrations: chain
                }).check()
                expect(change).toEqual({
                    pending: [
                        {
                            id: chain[0]?.id,
                            types: { Track: { kind: "safe", objects: 0 }, Tag: { kind: "safe", objects: 0 } }
                        },
                        { id: chain[1]?.id, types: { Track: { kind: "transforming", objects: 0 } } }
                    ],
                    blocking: [{ kind: "migrationMissing", migration: chain[1]?.id, type: "Track" }]
                })
                expect(yield* tableExists("umwelt_ledger")).toBe(false)
            })
        )

        it.effect("is up to date when Ledger's head is the chain's head", () =>
            Effect.gen(function* () {
                yield* reset
                const chain = chainOf([Track()])
                yield* applied(chain, 1)
                expect(yield* Umwelt.make([Track()], { migrations: chain }).check()).toEqual({
                    pending: [],
                    blocking: []
                })
            })
        )

        it.effect("counts the stored Objects each pending step touches", () =>
            Effect.gen(function* () {
                yield* reset
                const chain = extend(chainOf([Track(), Tag]), [Track({ note: Schema.optionalKey(Schema.String) })], {})
                yield* applied(chain, 1)
                yield* insertObject("Track", { slug: "a" }, { slug: "a" })
                yield* insertObject("Track", { slug: "b" }, { slug: "b" })
                yield* insertObject("Tag", { name: "x" })
                const change = yield* Umwelt.make([Track({ note: Schema.optionalKey(Schema.String) })], {
                    migrations: chain
                }).check()
                expect(change.pending).toEqual([
                    {
                        id: chain[1]?.id,
                        types: { Track: { kind: "safe", objects: 2 }, Tag: { kind: "destructive", objects: 1 } }
                    }
                ])
                expect(change.blocking).toEqual([{ kind: "typeRemovedWithObjects", type: "Tag" }])
            })
        )

        it.effect("blocks a unique key change while Objects exist", () =>
            Effect.gen(function* () {
                yield* reset
                const rekeyed = Track({ code: Schema.String }, { code: Schema.String })
                const chain = chainOf([Track({ code: Schema.String })], [rekeyed])
                const client = Umwelt.make([rekeyed], { migrations: chain })
                yield* applied(chain, 1)
                expect((yield* client.check()).blocking).toEqual([])
                yield* insertObject("Track", { slug: "a", code: "1" }, { slug: "a" })
                expect((yield* client.check()).blocking).toEqual([
                    { kind: "uniqueKeyChangeWithObjects", type: "Track" }
                ])
            })
        )

        it.effect("sees changed forms of an applied Migration, not a changed `migrate`", () =>
            Effect.gen(function* () {
                yield* reset
                const [first, second] = extend(chainOf([Track()]), [Track({ seconds: Schema.Finite })])
                const step = second?.types["Track"]
                if (first === undefined || second === undefined || step === undefined)
                    return yield* Effect.die(new Error("chain too short"))
                const filled = (migrate: () => unknown) => [
                    first,
                    { ...second, types: { Track: { ...step, migrate } } }
                ]
                yield* applied(
                    filled(() => ({ slug: "a", seconds: 1 })),
                    2
                )
                const check = (chain: readonly Migration[]) =>
                    Umwelt.make([Track({ seconds: Schema.Finite })], { migrations: chain }).check()
                expect((yield* check(filled(() => ({ slug: "a", seconds: 1 })))).blocking).toEqual([])
                expect((yield* check(filled(() => ({ slug: "a", seconds: 2 })))).blocking).toEqual([])
                const changedForm = { ...second, types: { Track: { ...step, after: { ...step.after, title: "x" } } } }
                expect((yield* check([first, changedForm])).blocking).toContainEqual({
                    kind: "appliedMigrationChanged",
                    migration: second.id
                })
            })
        )

        it.effect("blocks applied Migrations that changed or that the chain lacks", () =>
            Effect.gen(function* () {
                yield* reset
                const chain = chainOf([Track()], [Track({ note: Schema.optionalKey(Schema.String) })])
                const sql = yield* SqlClient.SqlClient
                yield* applied(chain, 2)
                yield* sql`update umwelt_ledger set hash = 'sha256:0' where position = 2`
                yield* sql`insert into umwelt_ledger (position, id, hash) values (3, 'gone', 'sha256:1')`
                const change = yield* Umwelt.make([Track({ note: Schema.optionalKey(Schema.String) })], {
                    migrations: chain
                }).check()
                expect(change.blocking).toEqual([
                    { kind: "appliedMigrationChanged", migration: chain[1]?.id },
                    { kind: "appliedMigrationChanged", migration: "gone" }
                ])
            })
        )
    })
})

describe("recursiveRelation", () => {
    it("blocks relation fields inside recursive schema parts", () => {
        const types = [Track(), Umwelt.type("Tree", { root: Part })]
        const change = changeOf(resolveModel(types, chainOf(types)), { ledger: [], objects: new Map() })
        expect(change.blocking).toEqual([{ kind: "recursiveRelation", type: "Tree", field: "root.track" }])
    })

    it("blocks them under definition names `$ref` escapes", () => {
        const types = [Track(), Umwelt.type("Tree", { root: EscapedPart })]
        const change = changeOf(resolveModel(types, chainOf(types)), { ledger: [], objects: new Map() })
        expect(change.blocking).toEqual([{ kind: "recursiveRelation", type: "Tree", field: "root.track" }])
    })
})

describe("blocking order", () => {
    it("reports Model, then chain, then Ledger", () => {
        const chain = chainOf([Track()], [Track({ seconds: Schema.Finite })])
        const [first, second] = chain
        if (first === undefined || second === undefined) throw new Error("chain too short")
        const broken = { ...second, parent: { id: first.id, hash: "sha256:0" } }
        const model = resolveModel(
            [Track({ AND: Schema.String }), Umwelt.type("Lost", { x: Schema.Unknown })],
            [first, broken]
        )
        const change = changeOf(model, { ledger: [{ id: first.id, hash: "sha256:1" }], objects: new Map() })
        expect(change.blocking.map(({ kind }) => kind)).toEqual([
            "invalidSchema",
            "reservedFieldName",
            "chainBehindModel",
            "chainBroken",
            "appliedMigrationChanged",
            "migrationMissing"
        ])
    })
})
