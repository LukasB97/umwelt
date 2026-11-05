# Umwelt

Umwelt states what application data means once, as Types in code, and derives storage, checks, Identity, references, and Model changes from them; it refuses state that is quietly wrong.
Library inside host application, not service: application code writes, queries, and deletes typed Objects.
Umwelt runs on host's database connection, Effect `SqlClient` or any SQL executor; [Client](CONTEXT/client.md) has an Effect face and a Promise face, and operations join host's transaction.
Umwelt owns its tables and their layout; host does not manage them.

Umwelt owns small primitive set: Type, Object, Relation, Query, Model, Migration, Ledger.
Developers model their domain with it; host application owns everything else, like accounts, access, events, background work.
Concept becomes primitive only when Umwelt must own its meaning for every application.

## Developers

Developers are people or coding agents building applications on Umwelt.
They define Types, unique keys, relations, and Type options in application code, fill Migrations Umwelt writes, and read, write, query, and delete Objects from same code.
They know their domain and application; they do not see Umwelt's tables and should not need to, with one named exception for host foreign keys, see [Object](CONTEXT/object.md).
They need typed content, safe references between content, and predictable Model changes.
Umwelt fails them when stored content becomes invalid, references break silently, or Model changes become unpredictable.

## Documents

Table chooses reading; on row match, read document start to end.

| Document | Read when |
| :-- | :-- |
| [Type](CONTEXT/type.md) | declaring Types: schema, unique key, unique constraints, `immutable`, `history`; using a Type as Effect Schema. |
| [Object](CONTEXT/object.md) | Object ID, Identity, payload, or host foreign keys on Objects. |
| [Relations](CONTEXT/relations.md) | declaring relations, strict or sparse references, reading them backwards, or how relations block Delete. |
| [Model](CONTEXT/model.md) | Model, Migrations, Ledger: changing Types, `umwelt create`, what the database knows of Model. |
| [Client](CONTEXT/client.md) | making Client, its operations and their types, typed errors, or transactions. |
| [Engineering](CONTEXT/engineering.md) | writing or reviewing code: static analysis, TypeScript, Effect. |
| [Authoring](CONTEXT/authoring.md) | writing, changing, or reviewing context source. |

## Context

Context records decisions future work must respect; code proves current implementation.
Each fact has one owner document; other documents link to it, never restate it.
Source lives in `.CONTEXT.source`, rendered to `CONTEXT.md` and `CONTEXT/`; change it following [Authoring](CONTEXT/authoring.md).
`examples/reference` is small host application against `src`; tests deploy it and run it against Postgres, and it follows these documents.
