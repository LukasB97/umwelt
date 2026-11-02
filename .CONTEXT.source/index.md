---
order: 0
render_to: CONTEXT.md
---
# Umwelt

Umwelt states what application data means once, as Types in code, and derives storage, checks, Identity, references, and Model changes from them; it refuses state that is quietly wrong.
Library inside host application, not service: application code writes, queries, and deletes typed Objects.
Umwelt runs on host's database connection, Effect `SqlClient` or any SQL executor; [Client](client/index.md) has an Effect face and a Promise face, and operations join host's transaction.
Umwelt owns its tables and their layout; host does not manage them.

Umwelt owns small primitive set: Type, Object, Relation, Query, Model, Migration, Ledger.
Developers model their domain with it; host application owns everything else, like accounts, access, events, background work.
Concept becomes primitive only when Umwelt must own its meaning for every application.

## Developers

Developers are people or coding agents building applications on Umwelt.
They define Types, unique keys, relations, and Type options in application code, fill Migrations Umwelt writes, and read, write, query, and delete Objects from same code.
They know their domain and application; they do not see Umwelt's tables and should not need to, with one named exception for host foreign keys, see [Object](object.md).
They need typed content, safe references between content, and predictable Model changes.
Umwelt fails them when stored content becomes invalid, references break silently, or Model changes become unpredictable.

## Documents

Table chooses reading; on row match, read document start to end.

`holon table()`

## Context

Context records decisions future work must respect; code proves current implementation.
Each fact has one owner document; other documents link to it, never restate it.
Source lives in `.CONTEXT.source`, rendered to `CONTEXT.md` and `CONTEXT/`; change it following [Authoring](authoring.md).
`examples/reference` is small host application against `src`; tests deploy it and run it against Postgres, and it follows these documents.
