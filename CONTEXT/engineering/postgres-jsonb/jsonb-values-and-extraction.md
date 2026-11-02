# JSONB Values And Extraction
## JSONB Value Model

`jsonb` stores parsed binary JSON.
It does not preserve insignificant whitespace or original object-key order; duplicate keys keep last value.

`jsonb` uses normal JSON value kinds: object, array, string, number, boolean, null.

JSON null is a JSON value, not SQL `NULL`.

```sql
'null'::jsonb IS NULL
```

Is false.

## Extraction Operators

Key JSONB extraction operators:

| Operator | Result | Meaning |
| :--- | :--- | :--- |
| `jsonb -> integer` | jsonb | array element |
| `jsonb -> text` | jsonb | object field |
| `jsonb ->> integer` | text | array element as text |
| `jsonb ->> text` | text | object field as text |
| `jsonb #> text[]` | jsonb | value at path |
| `jsonb #>> text[]` | text | value at path as text |

Array indexes are zero-based.
Negative indexes count from the end.

Extraction returns SQL `NULL` when structure mismatches or path is missing.
For existing JSON null, jsonb extraction returns JSONB null; text extraction returns SQL `NULL`.

This distinction matters:

```sql
'{"a": null}'::jsonb #> ARRAY['a']
```

Returns JSONB null.

```sql
'{"a": null}'::jsonb #>> ARRAY['a']
```

Returns SQL `NULL`.

`#>` preserves JSON-null-vs-missing distinction.
`#>>` does not.

## Text Extraction Loses JSON Type

`#>>` returns text.
Useful for guarded scalar casts/text predicates; invalid alone for JSON-strict equality.

JSON number `1` and string `"1"` can both produce text `1`.
`#>` and JSONB comparison preserve JSON type meaning.
