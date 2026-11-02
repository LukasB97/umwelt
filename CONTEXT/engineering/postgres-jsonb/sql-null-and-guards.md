# SQL Null And Guards
## SQL NULL And Three-Valued Logic

SQL predicates can be true, false, or NULL. `WHERE` keeps only true.

Normal comparisons with SQL `NULL` return SQL `NULL`.

```sql
payload #> ARRAY['x'] = NULL
```

Does not test missing.
Use `IS NULL` for SQL null; JSONB comparison for JSON null.

`IS DISTINCT FROM` differs when inequality needs SQL `NULL` to stay absent, false, or unknown.
It treats SQL `NULL` as comparable value and can make missing values count as distinct.

## Boolean Expression Reordering

PostgreSQL may reorder Boolean expressions in `WHERE` and `HAVING`.
`AND` guard cannot reliably protect failing cast.

Unsafe shape:

```sql
jsonb_typeof(payload #> ARRAY['age']) = 'number'
AND (payload #>> ARRAY['age'])::numeric > 30
```

Safer shape:

```sql
CASE
  WHEN jsonb_typeof(payload #> ARRAY['age']) = 'number'
  THEN (payload #>> ARRAY['age'])::numeric > 30
  ELSE NULL
END
```

`CASE` has planning caveats for constant subexpressions, but correctly guards casts depending on row values.
Lowered product language chooses fallback expression; PostgreSQL owns guard behavior, not product predicate result.
