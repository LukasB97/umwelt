# Deploy

```ts
type Deploy = {
  /**
   * Host's deploy step runs it before new instances start.
   * Runs Check; any blocking reason fails with `Blocked`. Then applies pending Migrations in order, in one transaction:
   * first Deploy creates Umwelt's tables;
   * per touched Type, `safe` is proven against stored content, `transforming` runs `migrate` over every Object and every history entry and validates each result against form after, `destructive` drops what the form drops;
   * after all Migrations, checks every strict relation against migrated current content;
   * Migrations run under unique constraints, as Writes do, so swapping values takes two Migrations; after them creates every declared one missing;
   * writes Ledger.
   * Right after commit, drops unique constraints Model no longer declares; inside host transaction or when drop fails, next Deploy does. Until then, Write or Migration meeting one fails with `SqlError`.
   * Failed Deploy changes nothing. Transforming steps cost one call per Object and per history entry. Model owns Migrations; Check owns Change.
   */
  (): Effect<Deployed, DeployError, SqlClient>
}
```

```ts
type Deployed = {
  /** Migration ids applied, in order. */
  applied: string[]
}

type DeployError =
  | Blocked           // Change has blocking reasons
  | MigrationFailed   // result fails form after or changes Identity, or `safe` step finds unfit content; names Object and cause
  | MissingTarget     // strict relation target missing after Migrations
  | UniqueViolation   // Migration result or stored content holds values of unique constraint twice
```

## Usage

```ts
// application's deploy step
Effect.gen(function* () {
  const { applied } = yield* umwelt.deploy()
  return applied
})
```
