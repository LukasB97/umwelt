---
order: 30
render_to: CONTEXT/engineering/postgres-jsonb/operators-and-containment.md
read_when: "Checking PostgreSQL JSONB existence operators, containment behavior, equality, ordering, or overloaded operator resolution."
---
# Operators And Containment
## Existence Operators

PostgreSQL existence operators are top-level only:

| Operator | Meaning |
| :--- | :--- |
| `jsonb ? text` | top-level key or top-level array string exists |
| `jsonb ?| text[]` | any listed string exists top-level |
| `jsonb ?& text[]` | all listed strings exist top-level |

For objects, they check keys.
For arrays, they check string elements.
They do not recurse or check object values.

Because arrays participate, these operators alone cannot express object-key-only semantics. Such consumer needs separate object-receiver check.

## Containment

`a @> b` means JSONB value `a` contains JSONB value `b`.
Containment is structural.

Object containment checks whether left object contains requested key/value structure; nesting matters.

Array containment ignores order.
Duplicate array elements are not separate required occurrences.

PostgreSQL special case: array may contain primitive JSON value:

```sql
'["foo"]'::jsonb @> '"foo"'::jsonb
```

Is true.

Reverse is not true.
Product languages may choose not to expose this special case directly.

## JSONB Comparisons

`jsonb` supports equality and ordering.
JSONB equality is normalized JSON equality, not text equality.

These are equal as JSONB:

```sql
'{"a":1,"b":2}'::jsonb = '{"b":2,"a":1}'::jsonb
```

Because `jsonb` ignores semantic object-key order.

## Type Resolution

PostgreSQL operators/functions are overloaded; one token can have several signatures.

Example:

```sql
jsonb -> integer
jsonb -> text
```

`payload -> 0` means array index `0`.
`payload -> '0'` usually means object key `"0"` after type resolution.

Explicit casts/parameter types remove semantics-affecting overload ambiguity.
