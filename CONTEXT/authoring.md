# Authoring

## Language

Lossless Minimal Information Language (LMIL): simplest words preserving exact meaning.
Grammar, punctuation, politeness, rhetorical style optional. Form optional unless it carries meaning.
Every word must add meaning; delete words removable without meaning loss. Prefer simple common words.
Meaning must stay exact. Rewrite when same meaning becomes shorter or clearer.

## Source

Source file starts with `#` title; Holon takes it as node title.
Front matter: `order` sorts siblings; `render_to` names output file from repository root; `read_when` gives root table row.
Link other source by relative Markdown link; Holon points link where target renders.
Call is inline code starting with word `holon`; root calls `table()`, which lists children with `read_when`. `holon.config.mjs` defines calls.
Each fact has one owner document. New fact extends its owner; new concept gets own file with `render_to` and `read_when`.
Render: `pnpm context`.

## Operation Documents

One document per operation: input type, operation type with rules as doc comments, output type, failure kinds, usage.
Shown types explain: they are the shape application code writes. Helper types appear by name with one sentence; their bodies live in code.
Every rule the shown type does not carry has one sentence naming who enforces it: exported type, or runtime with trigger and failure kind.
Exported types reject every call the shown types reject; code is stricter than shown type only where such sentence exists.
Usage block: calls on the Client of [Client](client.md), one rule per line, each returning Effect; `@ts-expect-error` lines show calls exported types reject.
`pnpm check` compiles every usage block; each type-enforced rule has one `@ts-expect-error`, each runtime failure kind one behavior test.
`open:` inside comment marks shape not decided yet.
