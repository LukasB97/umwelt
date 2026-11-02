# Static Code Analysis

These tools cover formatting, linting, structural rules and unused code, with a defined responsibility for each.

## Oxfmt

- **Why** Consistent formatting keeps mechanical style decisions out of code reviews.
- **Use** Standardize code layout and configured sorting.
- **Limits** Leave correctness and design rules to other tools.

Use four spaces, 120 columns, no semicolons and no trailing commas.

## Oxlint

- **Why** Common coding mistakes and framework pitfalls need automated checks.
- **Use** Enforce reusable JS/TS correctness and framework rules.
- **Limits** Leave formatting to Oxfmt.

Treat correctness and unsafe type flows as errors. Keep execution functions within 80 lines and nesting within three levels. Declarations and test scenario containers are counted separately; their executable helpers retain these limits. File length and approaching size limits warn and invite design review rather than forced fragmentation.

Effect checks: type-aware `@effect/tsgo` recommended preset + explicit safety errors in `.oxlintrc.json`; warnings do not fail CI. No blanket promotion: synchronous JS `catch` and externally supplied Layer dependencies remain valid. Baseline date diagnostic rejects explicit conversions too; leave disabled. Effect architecture/lifetime review remains necessary: [Anti-Patterns](effect/anti-patterns.md).

## tsgolint

- **Why** Some lint checks need type information to identify unsafe code.
- **Use** Run through Oxlint to catch floating promises, promise misuse and unsafe `any` flows.
- **Limits** Keep compiler checking as a separate responsibility.

## ast-grep

- **Why** Project-specific code patterns need rules beyond standard lint checks.
- **Use** Enforce structural rules and API restrictions, and perform codemods.
- **Limits** Avoid type/data-flow analysis and duplicating existing Oxlint rules.

## Knip

- **Why** Unused code and dependencies accumulate as the project changes.
- **Use** Find unused files, exports and dependencies.
- **Limits** Review dynamic references before treating findings as safe to delete.
