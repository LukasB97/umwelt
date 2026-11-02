---
order: 50
render_to: CONTEXT/engineering/postgres-jsonb/jsonpath-and-regex.md
read_when: "Checking PostgreSQL JSONPath operators, strict or lax mode, JSONPath suppressed errors, type/conversion methods, or like_regex behavior."
---
# JSONPath And Regex
## JSONPath

PostgreSQL JSONPath is separate language parsed inside SQL. Operators/functions using it include:

- `@?`
- `@@`
- `jsonb_path_exists`
- `jsonb_path_match`
- `jsonb_path_query`
- `jsonb_path_query_array`
- `jsonb_path_query_first`

`@?` checks if JSONPath returns any item.
`@@` evaluates a JSONPath predicate check.
If `@@` gets no single Boolean result, SQL result can be NULL.

Both suppress certain errors, including missing fields, unexpected JSON structures, and datetime/numeric errors.
This helps heterogeneous documents but changes exact true/false/NULL reading.

## JSONPath Strict And Lax

JSONPath modes: strict or default lax.

Lax mode can adapt structure through wrapping/unwrapping, changing product semantics when language requires operation on actual array.

Strict mode, explicit JSONB type guards, or equivalent structure are available boundaries when scalar-as-array behavior would be wrong.

## JSONPath Type And Conversion Methods

PostgreSQL JSONPath includes methods like:

- `.type()`
- `.size()`
- `.boolean()`
- `.string()`
- `.double()`
- `.number()`
- `.datetime()`
- `.date()`
- `.time()`
- `.timestamp()`

Some methods convert values; they are not pure type views unless behavior exactly matches.

## Regex

PostgreSQL JSONPath supports `like_regex`.
It uses PostgreSQL regex behavior, not JavaScript RegExp semantics.

Compiler emitting `like_regex` must account for:

- Supported flags
- Unsupported JavaScript-specific features
- Escaping regex text inside JSONPath text
- Escaping JSONPath text inside SQL text

JavaScript-shaped regex profiles need portable validation before PostgreSQL regex emission.
