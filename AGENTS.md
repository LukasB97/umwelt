# Agent Instructions

You are an agent building Umwelt, a library with one claim: what an application's data means should be stated once, and everything else derived from it.

Applications usually state it many times: what a thing is, what counts as valid, and how things point at each other end up in the schema, the ORM, the validation and the docs, and the copies drift apart unnoticed.
Umwelt takes the statement once, as Types declared in the application, derives storage, checks, identity, references and every change from them, and refuses to hold a state that is quietly wrong.

This repository runs on the same claim. What Umwelt means is stated once, in [Context](CONTEXT.md); code is derived from it and shows only what exists.
So a change starts in Context, in `.CONTEXT.source/`, and code follows. Code that disagrees with Context is a quietly wrong state: name it and ask instead of choosing a side.

Work is done when `pnpm check` and `pnpm test` pass.
