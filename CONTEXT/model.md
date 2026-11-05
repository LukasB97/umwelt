# Model

Model is the Types in code for one application: Types, schemas, unique keys, unique constraints, relations, Type options.
Developers write it in TypeScript with Effect Schema in one place, like `umwelt/model.ts`; [Client](client.md) types derive from it.
Type names are unique in Model; [Check](client/check.md) blocks repeats with `duplicateTypeName`.
Renaming Type is not supported.

```ts
/** The Types given to `Umwelt.make`. */
type Model = readonly AnyType[]
```

## Migrations

Migrations are the chain of every Model change since the first, as files Umwelt writes, like `umwelt/migrations/20261029-1432-seconds.ts`, given to `Umwelt.make` in order.
Developers never write old Types; the chain holds them.
First Migration holds whole Model serialized; every later one holds, per Type it touches, form before and form after, and names its `parent` by id and hash, so the chain is closed like git history.
Serialized form is JSON Schema Draft 2020-12 with Umwelt annotations for unique key, unique constraints, relations, and options: the stored side, see [Type](type.md).
Folding the chain gives the Model as the chain knows it; it must equal Model in code, else Check blocks with `chainBehindModel`.
A Type's version is the last Migration touching it; there are no version numbers.

```ts
/** One Migration file. `umwelt create` writes all of it; developers fill `migrate` where Check asks. */
export default Umwelt.migration({
  id: "20261029-1432-seconds",
  parent: { id: "20261027-0910-initial", hash: "sha256:…" },   // `null` for the first
  types: {
    Track: Umwelt.step({
      before: { /* serialized form before; `null` for new Type */ },
      after: { /* serialized form after; `null` for removed Type */ },
      /** Stored JSON of one Object in, stored JSON out; `old` and result typed from `before` and `after`. */
      migrate: (old) => ({ ...old, seconds: old.duration }),
    }),
  },
})
```

`umwelt create <name>` folds the chain, serializes Model, and writes the next Migration from the difference; `<name>` is only part of the file name. No difference, no file.
It runs where `umwelt/model.ts` lies, which exports exactly one Client; the chain's files live in `umwelt/migrations/`, `index.ts` listing them; TypeScript loads through Node's type stripping.
Each touched Type gets one kind:

- `safe`: stored content fits form after unchanged, like optional field added or union widened. No function. Changed unique constraints are `safe` too; Deploy proves them.
- `transforming`: stored content may not fit, like required field added, field type changed, or schema narrowed. `create` writes empty `migrate`; Check blocks with `migrationMissing` until filled.
- `destructive`: content is lost, like field removed or `history` turned off, which deletes history. Deploy applies it, Check shows it. Removed Type is `destructive` too, blocked with `typeRemovedWithObjects` while its Objects exist: delete them first.

Forms are read closed: stored content holds declared fields only.
Serialized form is what `create` compares; schema parts JSON Schema cannot express, like `Schema.filter` with own function, change without Migration.
`migrate` is pure, runs per Object and per history entry, must keep Identity, and its result must fit form after; immutable Types are migrated too.
Migration hash covers id, parent, and forms. Check sees changed forms, not changed `migrate` functions: an environment that has not applied a Migration runs its current function.
A Migration may carry `migrate` without change of form, for backfills.
Objects move between Types only through Client code today, with new Object IDs; later: step with `from`, keeping Object ID and history.
Applied Migrations are frozen; Check blocks changed ones with `appliedMigrationChanged`. Two Migrations naming the same `parent` are a fork, blocked with `fork`: one is recreated.
Many small Migrations in development are normal; squashing is later.

## Ledger

Ledger is what the database knows of Model: ids and hashes of applied Migrations, in order, written by [Deploy](client/deploy.md).
Database holds no Type versions and no schema to compare; Objects and history always have current form.
Object operations run only while Ledger's head is the chain's head, Model in code equals the folded chain, and Check finds no declaration problem in Model; else they fail with `ModelMismatch`. Deploy excludes writes while it runs: writes started before finish first or fail, none writes the old form after it. Concurrent Deploys run one after another, first Deploy included: one creates Umwelt's tables, others find them. Reads never wait: each sees Ledger and content in one snapshot, before Deploy or after it. Exception: while Deploy drops unique constraint Model no longer declares, reads wait for reads in flight.
Rolling deploy follows from that: Deploy runs before new instances start, and old instances fail after it.
Umwelt's own tables belong to the library; Deploy brings them to the library's layout, outside the chain.
