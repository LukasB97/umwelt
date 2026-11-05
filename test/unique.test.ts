import { describe, expect, it, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { changeOf } from "../src/chain/check.ts"
import { nextMigration } from "../src/chain/create.ts"
import { kindOf } from "../src/chain/classify.ts"
import type { AnyType, Unique } from "../src/declaration.ts"
import { Umwelt, UniqueViolation } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { chainOf, extend, insertObject, ledgerOf, reset, uniqueIndexes } from "./chain-fixture.ts"
import { TestDatabase, concurrently, lockWaits, pgClient, rejection } from "./database.ts"

const Team = Umwelt.type("Team", { slug: Schema.String }, { uniqueKey: Schema.Struct({ slug: Schema.String }) })
const Status = Umwelt.type(
    "Status",
    { team: Schema.String, name: Schema.String, color: Schema.String },
    { uniqueKey: Schema.Struct({ team: Schema.String, name: Schema.String }) }
)
const issueFields = {
    key: Schema.String,
    slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Umwelt.one("Status"),
    number: Schema.Int,
    labels: Umwelt.many("Team").sparse()
}
const Issue = Umwelt.type("Issue", issueFields, {
    uniqueKey: Schema.Struct({ key: Schema.String }),
    unique: [{ status: { team: true }, number: true }, { slug: true }]
})

const types = [Team, Status, Issue] as const
const umwelt = Umwelt.make(types, { migrations: chainOf(types) })

type StatusIdentity = { readonly team: string; readonly name: string }
const open: StatusIdentity = { team: "core", name: "open" }
const done: StatusIdentity = { team: "core", name: "done" }
const other: StatusIdentity = { team: "other", name: "open" }
const issue = (
    key: string,
    number: number,
    fields: { readonly slug?: string | null; readonly status?: StatusIdentity } = {}
) => ({ data: { key, number, status: open, labels: [], ...fields } })

const truncate = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`truncate umwelt_object cascade`
    yield* umwelt.write([
        { type: Status, data: { ...open, color: "red" } },
        { type: Status, data: { ...done, color: "green" } },
        { type: Status, data: { ...other, color: "blue" } }
    ])
})

const keys = Effect.map(umwelt.Issue.query({ orderBy: { key: "asc" } }), ({ objects }) =>
    objects.map(({ payload }) => payload.key)
)

const bySlug = { _tag: "UniqueViolation", type: "Issue", fields: { slug: true } }
const byTeamNumber = { _tag: "UniqueViolation", type: "Issue", fields: { number: true, status: { team: true } } }

describe("unique constraints on Write", () => {
    layer(TestDatabase("unique_write"))((it) => {
        it.effect("deploys the Model with one index per constraint", () =>
            Effect.gen(function* () {
                yield* umwelt.deploy()
                expect(yield* uniqueIndexes).toHaveLength(2)
            })
        )

        it.effect("single field: a second Object with the value fails with UniqueViolation and writes nothing", () =>
            Effect.gen(function* () {
                yield* truncate
                yield* umwelt.Issue.write(issue("A-1", 1, { slug: "a" }))
                expect(yield* Effect.flip(umwelt.Issue.write(issue("A-2", 2, { slug: "a" })))).toMatchObject(bySlug)
                expect(yield* keys).toEqual(["A-1"])
            })
        )

        it.effect("path into the reference's Identity: number unique per team of the status", () =>
            Effect.gen(function* () {
                yield* truncate
                yield* umwelt.Issue.write(issue("A-1", 1))
                yield* umwelt.Issue.write(issue("B-1", 1, { status: other }))
                const error = yield* Effect.flip(umwelt.Issue.write(issue("A-2", 1, { status: done })))
                expect(error).toBeInstanceOf(UniqueViolation)
                expect(error).toMatchObject(byTeamNumber)
                yield* umwelt.Issue.write(issue("A-2", 2, { status: done }))
                expect(yield* keys).toEqual(["A-1", "A-2", "B-1"])
            })
        )

        it.effect("unique values may change; Identity upsert works beside them", () =>
            Effect.gen(function* () {
                yield* truncate
                const created = yield* umwelt.Issue.write(issue("A-1", 1, { slug: "a" }))
                expect(yield* umwelt.Issue.write(issue("A-1", 1, { slug: "a" }))).toEqual({
                    id: created.id,
                    outcome: "unchanged"
                })
                expect(yield* umwelt.Issue.write(issue("A-1", 5, { slug: "b", status: done }))).toEqual({
                    id: created.id,
                    outcome: "changed"
                })
                yield* umwelt.Issue.write(issue("A-2", 1, { slug: "a" }))
                expect(yield* keys).toEqual(["A-1", "A-2"])
            })
        )

        it.effect("an update meeting another Object's values fails with UniqueViolation, never applying again", () =>
            Effect.gen(function* () {
                yield* truncate
                yield* umwelt.Issue.write(issue("A-1", 1, { slug: "a" }))
                yield* umwelt.Issue.write(issue("A-2", 2, { slug: "b" }))
                expect(yield* Effect.flip(umwelt.Issue.write({ data: { key: "A-2", slug: "a" } }))).toMatchObject(
                    bySlug
                )
                expect(
                    yield* Effect.flip(umwelt.Issue.write({ data: { key: "A-2", number: 1 }, mustExist: true }))
                ).toMatchObject(byTeamNumber)
                const { objects } = yield* umwelt.Issue.query({ where: { key: "A-2" } })
                expect(objects.map(({ payload }) => [payload.slug, payload.number])).toEqual([["b", 2]])
            })
        )

        it.effect("JSON null and absent values never collide", () =>
            Effect.gen(function* () {
                yield* truncate
                yield* umwelt.Issue.write(issue("A-1", 1))
                yield* umwelt.Issue.write(issue("A-2", 2))
                yield* umwelt.Issue.write(issue("A-3", 3, { slug: null }))
                yield* umwelt.Issue.write(issue("A-4", 4, { slug: null }))
                expect(yield* keys).toEqual(["A-1", "A-2", "A-3", "A-4"])
            })
        )

        it.effect("a list fails as a whole; swapping values inside one list fails too", () =>
            Effect.gen(function* () {
                yield* truncate
                yield* umwelt.Issue.write(issue("A-1", 1, { slug: "a" }))
                const failed = umwelt.Issue.write([issue("A-2", 2, { slug: "b" }), issue("A-3", 3, { slug: "a" })])
                expect(yield* Effect.flip(failed)).toMatchObject(bySlug)
                expect(yield* keys).toEqual(["A-1"])
                yield* umwelt.Issue.write(issue("A-2", 2, { slug: "b" }))
                const swap = umwelt.Issue.write([
                    { data: { key: "A-1", slug: "b" } },
                    { data: { key: "A-2", slug: "a" } }
                ])
                expect(yield* Effect.flip(swap)).toMatchObject(bySlug)
            })
        )

        it.effect("a concurrent create of the same values waits, then fails with UniqueViolation", () =>
            Effect.gen(function* () {
                yield* truncate
                const [, second, waited] = yield* concurrently(
                    umwelt.Issue.write(issue("A-1", 1, { slug: "a" })),
                    umwelt.Issue.write(issue("A-2", 2, { slug: "a" }))
                )
                expect(waited).toBe(true)
                expect(yield* Effect.flip(second)).toMatchObject(bySlug)
                expect(yield* keys).toEqual(["A-1"])
            })
        )

        it.effect("the Promise face throws UniqueViolation too", () =>
            Effect.gen(function* () {
                yield* truncate
                const database = umwelt.promise(yield* pgClient("unique_write"))
                yield* Effect.promise(() => database.Issue.write(issue("A-1", 1, { slug: "a" })))
                const error = yield* rejection(() => database.Issue.write(issue("A-2", 2, { slug: "a" })))
                expect(error).toBeInstanceOf(UniqueViolation)
                expect(error).toMatchObject(bySlug)
            })
        )
    })
})

const itemFields = { code: Schema.String, number: Schema.Int, slug: Schema.String }
const itemKey = Schema.Struct({ code: Schema.String })
const Item = (unique: readonly Unique<typeof itemFields>[]) =>
    Umwelt.type("Item", itemFields, { uniqueKey: itemKey, unique })

/** Deploys the chain's first Migration and stores Items, numbered and slugged as given, before the rest. */
const deployed = (chain: ReturnType<typeof chainOf>, first: AnyType, items: readonly [string, number, string][]) =>
    Effect.gen(function* () {
        yield* reset
        yield* Umwelt.make([first], { migrations: chain.slice(0, 1) }).deploy()
        yield* Effect.forEach(items, ([code, number, slug]) => insertObject("Item", { code, number, slug }, { code }))
    })

describe("unique constraints on Deploy", () => {
    layer(TestDatabase("unique_deploy"))((it) => {
        it.effect("adds, changes, and drops constraints", () =>
            Effect.gen(function* () {
                const none = Item([])
                const bySlugOnly = Item([{ slug: true }])
                const bySlugAndNumber = Item([{ slug: true, number: true }])
                const chain = chainOf([none], [bySlugOnly], [bySlugAndNumber], [none])
                yield* deployed(chain, none, [["a", 1, "x"]])
                expect(yield* uniqueIndexes).toEqual([])

                const added = Umwelt.make([bySlugOnly], { migrations: chain.slice(0, 2) })
                yield* added.deploy()
                const [slugIndex] = yield* uniqueIndexes
                expect(
                    yield* Effect.flip(added.Item.write({ data: { code: "b", number: 2, slug: "x" } }))
                ).toMatchObject({ _tag: "UniqueViolation", type: "Item", fields: { slug: true } })

                const changed = Umwelt.make([bySlugAndNumber], { migrations: chain.slice(0, 3) })
                yield* changed.deploy()
                const indexes = yield* uniqueIndexes
                expect(indexes).toHaveLength(1)
                expect(indexes).not.toContain(slugIndex)
                yield* changed.Item.write({ data: { code: "b", number: 2, slug: "x" } })
                expect(
                    yield* Effect.flip(changed.Item.write({ data: { code: "c", number: 2, slug: "x" } }))
                ).toMatchObject({ _tag: "UniqueViolation", fields: { number: true, slug: true } })

                const dropped = Umwelt.make([none], { migrations: chain })
                expect((yield* dropped.deploy()).applied).toEqual([chain[3]?.id])
                expect(yield* uniqueIndexes).toEqual([])
                yield* dropped.Item.write({ data: { code: "c", number: 2, slug: "x" } })
            })
        )

        it.effect("fails with UniqueViolation when stored content holds values twice, and changes nothing", () =>
            Effect.gen(function* () {
                const none = Item([])
                const bySlugOnly = Item([{ slug: true }])
                const chain = chainOf([none], [bySlugOnly])
                yield* deployed(chain, none, [
                    ["a", 1, "x"],
                    ["b", 2, "x"]
                ])
                const error = yield* Effect.flip(Umwelt.make([bySlugOnly], { migrations: chain }).deploy())
                expect(error).toBeInstanceOf(UniqueViolation)
                expect(error).toMatchObject({ _tag: "UniqueViolation", type: "Item", fields: { slug: true } })
                expect(yield* ledgerOf).toEqual([chain[0]?.id])
                expect(yield* uniqueIndexes).toEqual([])
            })
        )

        it.effect(
            "Migrations run under the constraints: passing through duplicates fails, a swap takes a free value",
            () =>
                Effect.gen(function* () {
                    const before = Item([{ number: true }])
                    const labeled = Umwelt.type(
                        "Item",
                        { ...itemFields, label: Schema.String },
                        { uniqueKey: itemKey, unique: [{ number: true }] }
                    )
                    const swapped = Umwelt.type(
                        "Item",
                        { ...itemFields, label: Schema.Literal("swapped") },
                        { uniqueKey: itemKey, unique: [{ number: true }] }
                    )
                    const items: [string, number, string][] = [
                        ["a", 1, "x"],
                        ["b", 2, "y"]
                    ]

                    const passing = extend(chainOf([before]), [labeled], {
                        Item: (old) => ({ ...old, number: 3 - Number(old["number"]), label: "swapped" })
                    })
                    yield* deployed(passing, before, items)
                    const error = yield* Effect.flip(Umwelt.make([labeled], { migrations: passing }).deploy())
                    expect(error).toBeInstanceOf(UniqueViolation)
                    expect(error).toMatchObject({ _tag: "UniqueViolation", type: "Item", fields: { number: true } })
                    expect(yield* ledgerOf).toEqual([passing[0]?.id])

                    const twice = extend(
                        extend(chainOf([before]), [labeled], {
                            Item: (old) => ({ ...old, number: Number(old["number"]) + 10, label: "moved" })
                        }),
                        [swapped],
                        { Item: (old) => ({ ...old, number: 13 - Number(old["number"]), label: "swapped" }) }
                    )
                    yield* deployed(twice, before, items)
                    const client = Umwelt.make([swapped], { migrations: twice })
                    expect((yield* client.deploy()).applied).toEqual([twice[1]?.id, twice[2]?.id])
                    const { objects } = yield* client.Item.query({ orderBy: { code: "asc" } })
                    expect(objects.map(({ payload }) => payload.number)).toEqual([2, 1])
                })
        )

        it.effect("a read, then Deploy dropping a constraint, then a write in one host transaction: no deadlock", () =>
            Effect.gen(function* () {
                const bySlugOnly = Item([{ slug: true }])
                const bySlugAndNumber = Item([{ slug: true, number: true }])
                const chain = chainOf([bySlugOnly], [bySlugAndNumber])
                yield* deployed(chain, bySlugOnly, [["a", 1, "x"]])
                const old = Umwelt.make([bySlugOnly], { migrations: chain.slice(0, 1) })
                const changed = Umwelt.make([bySlugAndNumber], { migrations: chain })
                const sql = yield* SqlClient.SqlClient
                const read = yield* Deferred.make<void>()
                const write = yield* Deferred.make<void>()
                const host = yield* Effect.forkChild(
                    sql.withTransaction(
                        Effect.gen(function* () {
                            yield* old.Item.query({})
                            yield* Deferred.succeed(read, undefined)
                            yield* Deferred.await(write)
                            return yield* Effect.flip(old.Item.write({ data: { code: "b", number: 2, slug: "y" } }))
                        })
                    )
                )
                yield* Deferred.await(read)
                const deploying = yield* Effect.forkChild(changed.deploy())
                // Deploy has committed; the drop of the superseded index waits for the host's read, the write passes it
                yield* lockWaits(1)
                yield* Deferred.succeed(write, undefined)
                expect(yield* Fiber.join(host)).toMatchObject({ _tag: "ModelMismatch" })
                expect((yield* Fiber.join(deploying)).applied).toEqual([chain[1]?.id])
                expect(yield* uniqueIndexes).toHaveLength(1)
            })
        )

        it.effect("inside a host transaction, Deploy leaves the superseded index to the next Deploy", () =>
            Effect.gen(function* () {
                const bySlugOnly = Item([{ slug: true }])
                const bySlugAndNumber = Item([{ slug: true, number: true }])
                const chain = chainOf([bySlugOnly], [bySlugAndNumber])
                yield* deployed(chain, bySlugOnly, [["a", 1, "x"]])
                const changed = Umwelt.make([bySlugAndNumber], { migrations: chain })
                const sql = yield* SqlClient.SqlClient
                yield* sql.withTransaction(changed.deploy())
                expect(yield* uniqueIndexes).toHaveLength(2)
                // the superseded index still holds; its violation is no constraint of the Model
                const stale = yield* Effect.flip(changed.Item.write({ data: { code: "b", number: 2, slug: "x" } }))
                expect(stale).toMatchObject({ _tag: "SqlError" })
                expect((yield* changed.deploy()).applied).toEqual([])
                expect(yield* uniqueIndexes).toHaveLength(1)
                yield* changed.Item.write({ data: { code: "b", number: 2, slug: "x" } })
            })
        )
    })
})

describe("unique declarations", () => {
    const blocking = (types: readonly AnyType[]) =>
        changeOf(resolveModel(types, chainOf(types)), { ledger: [], objects: new Map() }).blocking

    it("are part of the form: key and constraint order never count, a change is a safe Migration", () => {
        const form = (type: AnyType) => resolveModel([Team, Status, type], []).types.get("Issue")?.form
        const reordered = Umwelt.type("Issue", issueFields, {
            uniqueKey: Schema.Struct({ key: Schema.String }),
            unique: [{ slug: true }, { number: true, status: { team: true } }, { slug: true }]
        })
        expect(form(Issue)?.["x-umwelt-unique"]).toEqual([{ number: true, status: { team: true } }, { slug: true }])
        expect(form(reordered)).toEqual(form(Issue))
        const plain = Umwelt.type("Issue", issueFields, { uniqueKey: Schema.Struct({ key: Schema.String }) })
        const next = nextMigration(resolveModel(types, chainOf([Team, Status, plain])), "unique", new Date(0))
        const step = next?.types["Issue"]
        expect(step === undefined ? undefined : kindOf(step)).toBe("safe")
    })

    /** Status whose Identity holds a relation, so paths into it may descend into Team's Identity. */
    const TeamStatus = Umwelt.type(
        "Status",
        { team: Umwelt.one("Team"), name: Schema.String, color: Schema.String },
        { uniqueKey: Schema.Struct({ team: Umwelt.one("Team"), name: Schema.String }) }
    )

    it("valid ones block nothing, paths may descend through the target's Identity", () => {
        const deep = Umwelt.type("Issue", issueFields, {
            unique: [{ status: { team: { slug: true }, name: true } }, { status: true }]
        })
        expect(blocking([Team, Status, Issue])).toEqual([])
        expect(blocking([Team, TeamStatus, deep])).toEqual([])
    })

    it("invalid ones are rejected by the type and blocked by Check with invalidUnique", () => {
        const invalid = (unique: unknown, status: AnyType = Status) =>
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime declarations the types reject
            blocking([Team, status, Umwelt.type("Issue", issueFields, { unique: unique as [] })])
        const declarations = [
            // @ts-expect-error unknown field
            Umwelt.type("Issue", issueFields, { unique: [{ nope: true }] }),
            // @ts-expect-error `many` relation field
            Umwelt.type("Issue", issueFields, { unique: [{ labels: true }] }),
            // @ts-expect-error path below a field that is no `one` relation
            Umwelt.type("Issue", issueFields, { unique: [{ number: { value: true } }] }),
            // @ts-expect-error empty constraint
            Umwelt.type("Issue", issueFields, { unique: [{}] }),
            // @ts-expect-error leaves are `true`
            Umwelt.type("Issue", issueFields, { unique: [{ number: false }] })
        ]
        for (const declaration of declarations)
            expect(blocking([Team, Status, declaration])).toEqual([{ kind: "invalidUnique", type: "Issue" }])
        // the target's fields are known only in the Model: a path leaving its Identity is Check's
        const outside = Umwelt.type("Issue", issueFields, { unique: [{ status: { color: true } }] })
        expect(blocking([Team, Status, outside])).toEqual([{ kind: "invalidUnique", type: "Issue" }])
        const reason = [{ kind: "invalidUnique", type: "Issue" }]
        expect(invalid({ slug: true })).toEqual(reason)
        expect(invalid([{ status: { team: { slug: true } } }])).toEqual(reason)
        expect(invalid([{ status: { team: { slug: { deeper: true } } } }], TeamStatus)).toEqual(reason)
        expect(invalid([{ status: { nope: true } }], TeamStatus)).toEqual(reason)
        // prototype keys are no fields
        for (const key of ["constructor", "toString", "__proto__"]) {
            expect(invalid([{ [key]: true }])).toEqual(reason)
            expect(invalid([{ status: { [key]: true } }])).toEqual(reason)
            expect(invalid([{ status: { team: { [key]: true } } }], TeamStatus)).toEqual(reason)
        }
        const wide = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, true as const]))
        const fields = Object.fromEntries(Object.keys(wide).map((key) => [key, Schema.String]))
        expect(blocking([Umwelt.type("Wide", fields, { unique: [wide] })])).toEqual([
            { kind: "invalidUnique", type: "Wide" }
        ])
    })
})
