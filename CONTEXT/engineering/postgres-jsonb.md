# PostgreSQL JSONB Query Semantics
External PostgreSQL behavior constraining Umwelt's where compiler; evidence, not Umwelt product semantics.

Umwelt's where compiler may choose narrower behavior than PostgreSQL when product language needs stronger boundary.
[Sources And Boundary](postgres-jsonb/sources-and-boundary.md) owns mutable source-link verification rule.

| Document | Read when |
| :-- | :-- |
| [Sources And Boundary](postgres-jsonb/sources-and-boundary.md) | Checking PostgreSQL `current` source links or the verification rule before using external PostgreSQL facts. |
| [JSONB Values And Extraction](postgres-jsonb/jsonb-values-and-extraction.md) | Checking PostgreSQL jsonb value storage, JSON null, extraction operators, missing-path behavior, or text extraction behavior. |
| [Operators And Containment](postgres-jsonb/operators-and-containment.md) | Checking PostgreSQL JSONB existence operators, containment behavior, equality, ordering, or overloaded operator resolution. |
| [SQL Null And Guards](postgres-jsonb/sql-null-and-guards.md) | Checking PostgreSQL SQL NULL behavior, three-valued logic, WHERE matching, IS DISTINCT FROM, Boolean expression reordering, or CASE guard safety. |
| [JSONPath And Regex](postgres-jsonb/jsonpath-and-regex.md) | Checking PostgreSQL JSONPath operators, strict or lax mode, JSONPath suppressed errors, type/conversion methods, or like_regex behavior. |
| [Indexes](postgres-jsonb/indexes.md) | Checking whether PostgreSQL JSONB indexes or operator classes define query meaning. |
