---
order: 50
render_to: CONTEXT/client/check.md
read_when: "checking Model, Migrations, and Ledger before Deploy: Change shape, blocking reasons."
---
# Check

```ts
type Check = {
  /** Reads only. Compares Model, Migrations, and Ledger, see Model; runs before first Deploy too. */
  (): Effect<Change, never, SqlClient>
}
```

```ts
type Change = {
  /** Migrations after Ledger's head, in order. Empty, with empty `blocking`, means up to date. */
  pending: PendingMigration[]
  /** Any entry means Deploy fails. */
  blocking: BlockingReason[]
}

type PendingMigration = {
  id: string
  /** Per touched Type: kind, see Model, and Objects the step touches. */
  types: { [type: string]: { kind: "safe" | "transforming" | "destructive"; objects: number } }
}

/** Reported in this order: Model, then chain, then Ledger. Type, Relations, Query, and Model own each trigger. */
type BlockingReason =
  | { kind: "invalidSchema"; type: string }
  | { kind: "invalidUniqueKey" | "invalidUnique"; type: string }
  | { kind: "reservedTypeName" | "duplicateTypeName"; type: string }
  | { kind: "reservedFieldName"; type: string; field: string }
  | { kind: "unknownRelationTarget" | "relationTargetWithoutUniqueKey"; type: string; field: string; target: string }
  | { kind: "ambiguousRelation"; type: string; field: string }
  | { kind: "recursiveRelation"; type: string; field: string }
  | { kind: "immutableWithHistory"; type: string }
  | { kind: "uniqueKeyChangeWithObjects" | "typeRemovedWithObjects"; type: string }
  | { kind: "chainBehindModel" }                          // run `umwelt create`
  | { kind: "chainBroken" | "fork"; migration: string }
  | { kind: "appliedMigrationChanged"; migration: string }   // applied Migration changed, or missing from chain
  | { kind: "migrationMissing"; migration: string; type: string }
```

## Usage

```ts
Effect.gen(function* () {
  const change = yield* umwelt.check()
  // any blocking reason means Deploy fails; pending shows what Deploy would apply
  return change.blocking.length === 0 ? change.pending.map((m) => m.id) : []
})
```
