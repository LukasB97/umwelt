/** Check: compares Model, Migrations, and Ledger; reads only. See CONTEXT/client/check.md. */
import { Effect } from "effect"
import type { Change, PendingMigration } from "../api.ts"
import { canonicalJson } from "../canonical.ts"
import type { BlockingReason } from "../errors.ts"
import { migrationHash, type JsonSchema, type Migration } from "../migration.ts"
import type { ResolvedModel } from "../resolve.ts"
import { appliedMigrations, type Applied } from "../storage/gate.ts"
import { umweltSql } from "../storage/tables.ts"
import { chainReasons } from "./chain.ts"
import { kindOf } from "./classify.ts"
import { declarationReasons } from "./declarations.ts"

/** What the database holds: Ledger in order, and Objects per Type. Empty before the first Deploy. */
export type Stored = { readonly ledger: readonly Applied[]; readonly objects: ReadonlyMap<string, number> }

/** Objects exist only of Types some applied Migration made, so an empty Ledger means none; their table may not exist yet. */
export const stored = Effect.gen(function* () {
    const ledger = yield* appliedMigrations
    if (ledger.length === 0) return { ledger, objects: new Map<string, number>() } satisfies Stored
    const sql = yield* umweltSql
    const counts = yield* sql<{ type: string; count: number }>`select type, count(*)::int as count
        from umwelt_object group by type`
    return { ledger, objects: new Map(counts.map(({ type, count }) => [type, count])) } satisfies Stored
})

const order: readonly (readonly BlockingReason["kind"][])[] = [
    ["invalidSchema"],
    ["invalidUniqueKey"],
    ["reservedTypeName", "duplicateTypeName"],
    ["reservedFieldName"],
    ["unknownRelationTarget", "relationTargetWithoutUniqueKey"],
    ["ambiguousRelation"],
    ["recursiveRelation"],
    ["immutableWithHistory"],
    ["uniqueKeyChangeWithObjects", "typeRemovedWithObjects"],
    ["chainBehindModel"],
    ["chainBroken", "fork"],
    ["appliedMigrationChanged"],
    ["migrationMissing"]
]
const rank = (reason: BlockingReason) => order.findIndex((kinds) => kinds.includes(reason.kind))

const uniqueKey = (form: JsonSchema) => canonicalJson(form["x-umwelt-unique-key"] ?? null)

const contentReasons = (pending: readonly Migration[], objects: Stored["objects"]): readonly BlockingReason[] =>
    pending.flatMap((migration) =>
        Object.entries(migration.types).flatMap(([type, { before, after }]): BlockingReason[] => {
            if (before === null || (objects.get(type) ?? 0) === 0) return []
            if (after === null) return [{ kind: "typeRemovedWithObjects", type }]
            return uniqueKey(before) === uniqueKey(after) ? [] : [{ kind: "uniqueKeyChangeWithObjects", type }]
        })
    )

/** Every applied Migration must be the chain's Migration at its position, unchanged. */
const ledgerReasons = (migrations: readonly Migration[], ledger: readonly Applied[]): readonly BlockingReason[] =>
    ledger.flatMap((applied, index): BlockingReason[] => {
        const migration = migrations[index]
        return migration?.id === applied.id && migrationHash(migration) === applied.hash
            ? []
            : [{ kind: "appliedMigrationChanged", migration: applied.id }]
    })

const missingReasons = (pending: readonly Migration[]): readonly BlockingReason[] =>
    pending.flatMap((migration) =>
        Object.entries(migration.types)
            .filter(([, step]) => kindOf(step) === "transforming" && typeof step.migrate !== "function")
            .map(([type]): BlockingReason => ({ kind: "migrationMissing", migration: migration.id, type }))
    )

const pendingOf = (migration: Migration, objects: Stored["objects"]): PendingMigration => ({
    id: migration.id,
    types: Object.fromEntries(
        Object.entries(migration.types).map(([type, step]) => [
            type,
            { kind: kindOf(step), objects: objects.get(type) ?? 0 }
        ])
    )
})

/** Change for a Model against what the database holds; blocking reasons in Check's order. */
export const changeOf = (model: ResolvedModel, { ledger, objects }: Stored): Change => {
    const pending = model.migrations.slice(ledger.length)
    const blocking: readonly BlockingReason[] = [
        ...declarationReasons(model),
        ...contentReasons(pending, objects),
        ...(model.current ? [] : [{ kind: "chainBehindModel" } as const]),
        ...chainReasons(model.migrations),
        ...ledgerReasons(model.migrations, ledger),
        ...missingReasons(pending)
    ]
    return {
        pending: pending.map((migration) => pendingOf(migration, objects)),
        blocking: blocking.toSorted((left, right) => rank(left) - rank(right))
    }
}

export const check = (model: ResolvedModel) => Effect.map(stored, (state) => changeOf(model, state))
