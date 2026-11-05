import { describe, expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Umwelt, type Where } from "../src/index.ts"
import { resolveModel } from "../src/resolve.ts"
import { compileWhere } from "../src/where.ts"
import { chainOf } from "./chain-fixture.ts"
import { TestDatabase } from "./database.ts"

const Check = Schema.Struct({ by: Schema.String, at: Schema.Date })
const Step = Schema.Struct({
    title: Schema.String,
    done: Schema.Boolean,
    tags: Schema.Array(Schema.String),
    check: Schema.optionalKey(Schema.NullOr(Check))
})
const Gone = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("trashed") }),
    Schema.Struct({ kind: Schema.Literal("archived"), by: Schema.String })
])
const Label = Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })])
const Task = Umwelt.type(
    "Task",
    {
        name: Schema.String,
        gone: Schema.optionalKey(Schema.NullOr(Gone)),
        priorities: Schema.Array(Schema.String),
        scores: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Finite))),
        steps: Schema.Array(Step),
        label: Schema.optionalKey(Label),
        labels: Schema.optionalKey(Schema.Array(Label)),
        meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
    },
    { uniqueKey: Schema.Struct({ name: Schema.String }) }
)
const Measure = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), n: Schema.Finite, at: Schema.Date }),
    Schema.Struct({ kind: Schema.Literal("b"), n: Schema.FiniteFromString, at: Schema.DateFromMillis })
])
const Sample = Umwelt.type(
    "Sample",
    {
        name: Schema.String,
        measure: Measure,
        readings: Schema.Array(Measure),
        side: Schema.optionalKey(
            Schema.Union([Schema.Struct({ left: Schema.String }), Schema.Struct({ right: Schema.Finite })])
        ),
        pair: Schema.optionalKey(Schema.Struct({ 0: Schema.String })),
        // oxlint-disable-next-line effecttsgo/schema-number -- non-finite values are what this test stores
        values: Schema.optionalKey(Schema.Array(Schema.Number)),
        stamps: Schema.optionalKey(Schema.Array(Schema.DateFromMillis)),
        notes: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.Struct({ text: Schema.String })))),
        grid: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Finite))),
        either: Schema.optionalKey(
            Schema.Union([
                Schema.Struct({ value: Schema.Struct({ text: Schema.String }), count: Schema.Finite }),
                Schema.Struct({
                    value: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
                    count: Schema.Boolean
                })
            ])
        )
    },
    { uniqueKey: Schema.Struct({ name: Schema.String }) }
)
const types = [Task, Sample] as const
const chain = chainOf(types)
const umwelt = Umwelt.make(types, { migrations: chain })
const model = resolveModel(types, chain)

const day = (date: number) => new Date(`2026-10-0${date}T08:00:00.000Z`)

const seedAll = Effect.gen(function* () {
    yield* umwelt.deploy()
    yield* umwelt.Task.write([
        {
            data: {
                name: "a",
                gone: { kind: "trashed" },
                priorities: ["high", "low"],
                scores: [1, 5],
                steps: [
                    { title: "plan", done: true, tags: ["x"] },
                    { title: "ship", done: false, tags: [], check: { by: "lu", at: day(2) } }
                ],
                label: "a",
                labels: ["a", { text: "c" }],
                meta: { team: "core" }
            }
        },
        {
            data: {
                name: "b",
                gone: { kind: "archived", by: "max" },
                priorities: ["low"],
                scores: null,
                steps: [{ title: "plan", done: true, tags: ["y"], check: null }],
                label: { text: "b" }
            }
        },
        { data: { name: "c", gone: null, priorities: [], steps: [], meta: { owner: "lu" } } },
        {
            data: {
                name: "d",
                priorities: ["high"],
                scores: [10],
                steps: [{ title: "x", done: false, tags: ["x", "y"] }]
            }
        }
    ])
})

const samples = (where: Where<typeof types, typeof Sample>) =>
    Effect.map(umwelt.Sample.query({ where, orderBy: { name: "asc" } }), ({ objects }) =>
        objects.map((object) => object.payload.name)
    )

const names = (where: Where<typeof types, typeof Task>) =>
    Effect.map(umwelt.Task.query({ where, orderBy: { name: "asc" } }), ({ objects }) =>
        objects.map((object) => object.payload.name)
    )

const rejected = (effect: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
    Effect.map(Effect.flip(effect), (error) => expect(error).toMatchObject({ _tag: "ValidationFailed" }))

/** SQL text and parameters of a where, as Query and Delete send it. */
const compiledOn = (name: string, where: unknown) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const resolved = model.types.get(name)
        if (resolved === undefined) return yield* Effect.die(new Error(`no ${name}`))
        const condition = yield* compileWhere(model, resolved, where, sql.literal("o"))
        const [text, parameters] =
            sql`select o.id from umwelt_object o where o.type = ${name} and ${condition}`.compile()
        return { text, parameters }
    })
const compiled = (where: Where<typeof types, typeof Task>) => compiledOn("Task", where)
const compiledSample = (where: Where<typeof types, typeof Sample>) => compiledOn("Sample", where)

describe("nested where", () => {
    layer(TestDatabase("nested_where"))((it) => {
        it.effect("seeds", () => seedAll)

        it.effect("is and isNot read the fields of a struct value; a union's fields span its members", () =>
            Effect.gen(function* () {
                expect(yield* names({ gone: { is: { kind: { in: ["trashed", "archived"] } } } })).toEqual(["a", "b"])
                expect(yield* names({ gone: { is: { by: Umwelt.absent } } })).toEqual(["a"])
                expect(yield* names({ gone: { isNot: { by: Umwelt.absent } } })).toEqual(["b", "c", "d"])
                expect(yield* names({ gone: { is: { kind: "trashed" } } })).toEqual(["a"])
                expect(yield* names({ gone: { is: { kind: "archived", by: { contains: "ma" } } } })).toEqual(["b"])
                expect(yield* names({ gone: { is: { OR: [{ kind: "trashed" }, { kind: "archived" }] } } })).toEqual([
                    "a",
                    "b"
                ])
                expect(yield* names({ gone: { is: { kind: "trashed" }, equals: { kind: "trashed" } } })).toEqual(["a"])
                expect(yield* names({ meta: { equals: { team: "core" } } })).toEqual(["a"])
            })
        )

        it.effect("a field is read in each encoding it has across the members, and OR-ed", () =>
            Effect.gen(function* () {
                const a = (n: number, at: number) => ({ kind: "a" as const, n, at: day(at) })
                const b = (n: number, at: number) => ({ kind: "b" as const, n, at: day(at) })
                yield* umwelt.Sample.write([
                    { data: { name: "s1", measure: a(5, 1), readings: [a(5, 1), b(5, 1)] } },
                    { data: { name: "s2", measure: b(5, 1), readings: [b(5, 1)] } },
                    { data: { name: "s3", measure: b(6, 2), readings: [a(6, 2), b(7, 3)] } },
                    { data: { name: "s4", measure: a(7, 3), readings: [] } }
                ])
                expect(yield* samples({ measure: { is: { kind: "b", n: 5 } } })).toEqual(["s2"])
                expect(yield* samples({ measure: { isNot: { kind: "b", n: 5 } } })).toEqual(["s1", "s3", "s4"])
                expect(yield* samples({ measure: { is: { n: 5 } } })).toEqual(["s1", "s2"])
                expect(yield* samples({ measure: { isNot: { n: 5 } } })).toEqual(["s3", "s4"])
                expect(yield* samples({ measure: { is: { NOT: { n: 5 } } } })).toEqual(["s3", "s4"])
                expect(yield* samples({ measure: { is: { n: { gt: 5, lt: 7 } } } })).toEqual(["s3"])
                expect(yield* samples({ measure: { is: { n: { in: [6, 7] } } } })).toEqual(["s3", "s4"])
                expect(yield* samples({ measure: { is: { kind: "b", at: day(1) } } })).toEqual(["s2"])
                expect(yield* samples({ measure: { is: { at: day(1) } } })).toEqual(["s1", "s2"])
                expect(yield* samples({ measure: { isNot: { at: day(1) } } })).toEqual(["s3", "s4"])
                expect(yield* samples({ measure: { is: { at: { gt: day(1) } } } })).toEqual(["s3", "s4"])
                expect(yield* samples({ measure: { is: { kind: { in: ["a", "b"] }, n: 7 } } })).toEqual(["s4"])
                expect(yield* samples({ readings: { some: { n: 5 } } })).toEqual(["s1", "s2"])
                expect(yield* samples({ readings: { every: { n: 5 } } })).toEqual(["s1", "s2", "s4"])
                expect(yield* samples({ readings: { none: { n: 5 } } })).toEqual(["s3", "s4"])
                expect(yield* samples({ readings: { every: { at: { lt: day(3) } } } })).toEqual(["s1", "s2", "s4"])
                expect(yield* samples({ readings: { none: { at: day(2) } } })).toEqual(["s1", "s2", "s4"])
                expect(yield* samples({ readings: { some: { kind: "b", n: { gt: 6 } } } })).toEqual(["s3"])
                // @ts-expect-error no member holds kind "c"
                yield* rejected(samples({ measure: { is: { kind: "c" } } }))
                // @ts-expect-error no encoding of `n` takes a string
                yield* rejected(samples({ measure: { is: { n: "5" } } }))
                // @ts-expect-error `kind` is in every member and required
                yield* rejected(samples({ measure: { is: { kind: Umwelt.absent } } }))
                const result = yield* umwelt.Sample.delete({
                    where: { readings: { every: { n: 5 } }, NOT: { name: "s4" } }
                })
                expect(result.deleted).toHaveLength(2)
                expect(yield* samples({ name: { in: ["s1", "s2", "s3", "s4"] } })).toEqual(["s3", "s4"])
            })
        )

        it.effect("a where over a union of structs is one object type over all member keys, its fields AND-ed", () =>
            Effect.gen(function* () {
                const measure = { kind: "a", n: 1, at: day(1) } as const
                yield* umwelt.Sample.write([
                    { data: { name: "l", measure, readings: [], side: { left: "x" } } },
                    { data: { name: "r", measure, readings: [], side: { right: 1 } } },
                    { data: { name: "p", measure, readings: [], pair: { 0: "x" } } }
                ])
                const only = { name: { in: ["l", "r", "p"] } }
                expect(yield* samples({ ...only, side: { is: { left: "x" } } })).toEqual(["l"])
                expect(yield* samples({ ...only, side: { is: { left: "x", right: 1 } } })).toEqual([])
                expect(yield* samples({ ...only, side: { is: { OR: [{ left: "x" }, { right: 1 }] } } })).toEqual([
                    "l",
                    "r"
                ])
                expect(yield* samples({ ...only, side: { is: { right: Umwelt.absent } } })).toEqual(["l"])
                expect(yield* samples({ ...only, side: { isNot: { left: Umwelt.absent } } })).toEqual(["l", "p"])
                expect(yield* samples({ ...only, pair: { is: { 0: "x" } } })).toEqual(["p"])
                // @ts-expect-error `0` holds strings
                yield* rejected(samples({ ...only, pair: { is: { 0: 1 } } }))
            })
        )

        it.effect("elements: nullable structs, numbers with Infinity, DateFromMillis, arrays of arrays", () =>
            Effect.gen(function* () {
                const measure = { kind: "a", n: 1, at: day(1) } as const
                yield* umwelt.Sample.write([
                    {
                        data: {
                            name: "e1",
                            measure,
                            readings: [],
                            values: [1, Infinity],
                            stamps: [day(1), day(3)],
                            notes: [null, { text: "x" }],
                            grid: [[1, 2], [5]]
                        }
                    },
                    {
                        data: {
                            name: "e2",
                            measure,
                            readings: [],
                            values: [-Infinity, 3],
                            stamps: [day(2)],
                            notes: [{ text: "y" }],
                            grid: [[]]
                        }
                    }
                ])
                const only = { name: { in: ["e1", "e2"] } }
                expect(yield* samples({ ...only, notes: { some: { text: "x" } } })).toEqual(["e1"])
                expect(yield* samples({ ...only, notes: { every: { text: { contains: "y" } } } })).toEqual(["e2"])
                expect(yield* samples({ ...only, notes: { none: { text: "y" } } })).toEqual(["e1"])
                expect(yield* samples({ ...only, values: { some: { gt: 1e300 } } })).toEqual(["e1"])
                expect(yield* samples({ ...only, values: { some: { lt: -1e300 } } })).toEqual(["e2"])
                expect(yield* samples({ ...only, values: { some: Infinity } })).toEqual(["e1"])
                expect(yield* samples({ ...only, values: { every: { lt: Infinity } } })).toEqual(["e2"])
                expect(yield* samples({ ...only, values: { none: { gt: 2 } } })).toEqual([])
                expect(yield* samples({ ...only, stamps: { some: day(2) } })).toEqual(["e2"])
                expect(yield* samples({ ...only, stamps: { some: { gt: day(2) } } })).toEqual(["e1"])
                expect(yield* samples({ ...only, stamps: { every: { lt: day(3) } } })).toEqual(["e2"])
                expect(yield* samples({ ...only, grid: { some: { some: 5 } } })).toEqual(["e1"])
                expect(yield* samples({ ...only, grid: { some: { every: { lt: 3 } } } })).toEqual(["e1", "e2"])
                expect(yield* samples({ ...only, grid: { every: { none: { gt: 1 } } } })).toEqual(["e2"])
                expect(yield* samples({ ...only, grid: { some: { equals: [5] } } })).toEqual(["e1"])
            })
        )

        it.effect("each equality reached through is and some carries the payload containment it implies", () =>
            Effect.gen(function* () {
                const kind = yield* compiledSample({ readings: { some: { kind: "a" } } })
                expect(kind.parameters).toContain(JSON.stringify({ readings: [{ kind: "a" }] }))
                const names = yield* compiledSample({ name: { in: ["s1", "s2"] } })
                expect(names.parameters).toContain(JSON.stringify({ name: "s1" }))
                expect(names.parameters).toContain(JSON.stringify({ name: "s2" }))
                const n = yield* compiledSample({ measure: { is: { n: 5 } } })
                expect(n.parameters).toContain(JSON.stringify({ measure: { n: 5 } }))
                expect(n.parameters).toContain(JSON.stringify({ measure: { n: "5" } }))
                const negated = yield* Effect.forEach(
                    [
                        { measure: { isNot: { kind: "a" } } },
                        { readings: { every: { kind: "a" } } },
                        { readings: { none: { kind: "a" } } },
                        { measure: { is: { NOT: { kind: "a" } } } }
                    ] as const,
                    compiledSample
                )
                expect(negated.map(({ text }) => text).join(" ")).not.toContain("o.payload @> ")
            })
        )

        it.effect("a field takes what its values take across the members holding it, like one union", () =>
            Effect.gen(function* () {
                // @ts-expect-error `value` holds a struct in one member, a string in the other
                yield* rejected(samples({ either: { is: { value: { is: { text: "x" } } } } }))
                // @ts-expect-error `value` holds an array in one member, a string in the other
                yield* rejected(samples({ either: { is: { value: { some: "x" } } } }))
                // @ts-expect-error `count` holds a number in one member, a boolean in the other
                yield* rejected(samples({ either: { is: { count: { gt: 1 } } } }))
                // @ts-expect-error `count` holds no strings only
                yield* rejected(samples({ either: { is: { count: { contains: "1" } } } }))
            })
        )

        it.effect("JSON null and absent are no object and no array: is, some false; isNot, every, none true", () =>
            Effect.gen(function* () {
                expect(yield* names({ gone: { equals: null } })).toEqual(["c"])
                expect(yield* names({ gone: Umwelt.absent })).toEqual(["d"])
                expect(yield* names({ gone: { isNot: { kind: "trashed" } } })).toEqual(["b", "c", "d"])
                expect(yield* names({ gone: { is: { NOT: { kind: "trashed" } } } })).toEqual(["b"])
                expect(yield* names({ scores: { some: { gt: 0 } } })).toEqual(["a", "d"])
                expect(yield* names({ scores: { every: { lt: 6 } } })).toEqual(["a", "b", "c"])
                expect(yield* names({ scores: { none: { gt: 4 } } })).toEqual(["b", "c"])
                expect(yield* names({ steps: { some: { check: { isNot: { by: "lu" } }, done: true } } })).toEqual([
                    "a",
                    "b"
                ])
            })
        )

        it.effect("some, every, none on scalar arrays take a value or operators", () =>
            Effect.gen(function* () {
                expect(yield* names({ priorities: { some: "high" } })).toEqual(["a", "d"])
                expect(yield* names({ priorities: { every: "low" } })).toEqual(["b", "c"])
                expect(yield* names({ priorities: { none: "high" } })).toEqual(["b", "c"])
                expect(yield* names({ priorities: { some: { in: ["low", "mid"] } } })).toEqual(["a", "b"])
                expect(yield* names({ priorities: { some: { contains: "ig" } } })).toEqual(["a", "d"])
                expect(yield* names({ priorities: { some: "high", none: "low" } })).toEqual(["d"])
                expect(yield* names({ scores: { some: { gt: 4 } } })).toEqual(["a", "d"])
                expect(yield* names({ priorities: { equals: ["low"] } })).toEqual(["b"])
            })
        )

        it.effect("some, every, none on object arrays take a where over the element, nesting at any depth", () =>
            Effect.gen(function* () {
                expect(yield* names({ steps: { some: { done: false } } })).toEqual(["a", "d"])
                expect(yield* names({ steps: { every: { done: true } } })).toEqual(["b", "c"])
                expect(yield* names({ steps: { none: { title: "plan" } } })).toEqual(["c", "d"])
                expect(yield* names({ steps: { some: { check: { is: { by: "lu" } } } } })).toEqual(["a"])
                expect(yield* names({ steps: { some: { check: { is: { at: { gt: day(1) } } } } } })).toEqual(["a"])
                expect(yield* names({ steps: { some: { tags: { some: "y" } } } })).toEqual(["b", "d"])
                expect(yield* names({ steps: { some: { tags: { every: "x" }, done: false } } })).toEqual(["a"])
                expect(yield* names({ steps: { some: { check: Umwelt.absent, done: false } } })).toEqual(["d"])
            })
        )

        it.effect("AND, OR, NOT inside nested wheres", () =>
            Effect.gen(function* () {
                expect(
                    yield* names({ steps: { some: { AND: [{ done: false }, { NOT: { title: "ship" } }] } } })
                ).toEqual(["d"])
                expect(yield* names({ steps: { some: { OR: [{ title: "ship" }, { tags: { some: "y" } }] } } })).toEqual(
                    ["a", "b", "d"]
                )
                expect(
                    yield* names({ gone: { is: { OR: [{ kind: "trashed" }, { by: "max" }] } }, NOT: { name: "a" } })
                ).toEqual(["b"])
            })
        )

        it.effect("rejects times, mixed values, and shapes the schema does not hold", () =>
            Effect.gen(function* () {
                // @ts-expect-error times belong to Objects, not to values
                yield* rejected(names({ gone: { is: { [Umwelt.createdAt]: { gt: day(1) } } } }))
                // @ts-expect-error times belong to Objects, not to elements
                yield* rejected(names({ steps: { some: { [Umwelt.changedAt]: { gt: day(1) } } } }))
                // @ts-expect-error `label` mixes strings and objects
                yield* rejected(names({ label: { is: { text: "b" } } }))
                // @ts-expect-error elements of `labels` mix strings and objects: a where on none
                yield* rejected(names({ labels: { some: { text: "c" } } }))
                // @ts-expect-error `is` on an array
                yield* rejected(names({ priorities: { is: { length: 1 } } }))
                // @ts-expect-error `some` on an object
                yield* rejected(names({ gone: { some: { kind: "trashed" } } }))
                // @ts-expect-error object elements take a where, not a value
                yield* rejected(names({ steps: { some: "plan" } }))
                // @ts-expect-error scalar elements take a value or operators, not a where
                yield* rejected(names({ priorities: { some: { title: "high" } } }))
                // @ts-expect-error empty nested where
                yield* rejected(names({ gone: { is: {} } }))
                // @ts-expect-error no such field
                yield* rejected(names({ gone: { is: { reason: "x" } } }))
                // @ts-expect-error `kind` is in every member and required
                yield* rejected(names({ gone: { is: { kind: Umwelt.absent } } }))
                // @ts-expect-error records are no structs: equals only
                yield* rejected(names({ meta: { is: { team: "core" } } }))
                // @ts-expect-error records are no structs: equals only
                yield* rejected(names({ meta: { isNot: { team: Umwelt.absent } } }))
                // @ts-expect-error empty AND
                yield* rejected(names({ steps: { some: { AND: [] } } }))
                // @ts-expect-error `done` is a boolean
                yield* rejected(names({ steps: { every: { done: "yes" } } }))
                expect(yield* names({ label: { equals: { text: "b" } } })).toEqual(["b"])
                expect(yield* names({ labels: { some: { equals: { text: "c" } } } })).toEqual(["a"])
                expect(yield* names({ labels: { some: { in: ["a", "b"] } } })).toEqual(["a"])
            })
        )

        it.effect("deletes by a nested where", () =>
            Effect.gen(function* () {
                const result = yield* umwelt.Task.delete({ where: { steps: { some: { tags: { some: "y" } } } } })
                expect(result.deleted).toHaveLength(2)
                expect(yield* names({ name: { in: ["a", "b", "c", "d"] } })).toEqual(["a", "c"])
                yield* rejected(
                    // @ts-expect-error times belong to Objects
                    umwelt.Task.delete({ where: { gone: { is: { [Umwelt.createdAt]: { gt: day(1) } } } } })
                )
            })
        )

        it.effect("equality inside is and some becomes payload containment the index serves", () =>
            Effect.gen(function* () {
                const gone = yield* compiled({ gone: { is: { kind: "trashed" } } })
                expect(gone.text).toContain("o.payload @> ")
                expect(gone.parameters).toContain(JSON.stringify({ gone: { kind: "trashed" } }))
                const steps = yield* compiled({ steps: { some: { done: false, tags: { some: "x" } } } })
                expect(steps.parameters).toContain(JSON.stringify({ steps: [{ done: false, tags: ["x"] }] }))
                const priorities = yield* compiled({ priorities: { some: "high", every: { in: ["high"] } } })
                expect(priorities.parameters).toContain(JSON.stringify({ priorities: ["high"] }))
                const loose = yield* compiled({ gone: { isNot: { kind: "trashed" } } })
                expect(loose.text).not.toContain("o.payload @> ")
                const sql = yield* SqlClient.SqlClient
                yield* sql`insert into umwelt_object (type, identity, payload)
                    select 'Task', jsonb_build_object('name', i::text),
                        jsonb_build_object('name', i::text, 'priorities', '[]'::jsonb, 'steps', '[]'::jsonb)
                    from generate_series(1, 20000) i`
                yield* sql`analyze umwelt_object`
                const plan = yield* sql.unsafe<{ "QUERY PLAN": string }>(
                    `explain (costs off) ${steps.text}`,
                    steps.parameters
                )
                expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("umwelt_object_payload")
            })
        )
    })
})
