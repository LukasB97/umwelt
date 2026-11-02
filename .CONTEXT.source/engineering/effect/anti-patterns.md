---
order: 20
render_to: CONTEXT/engineering/effect/anti-patterns.md
read_when: "writing or reviewing Effect code for runtime, error, dependency, cancellation and resource-lifetime mistakes."
---
# Effect v4: Systemic Anti-Patterns & Invariant Guide

Audience: SOTA coding agents. Reviewed baseline: `effect@4.0.0`, `@effect/tsgo@0.48.0`. Installed exports/declarations take precedence. `[Δ4]` marks v4 shifts.\
Format: **Bad Route → Broken System Invariant → Idiomatic Repair.**
Diagnostics: exact tsgo names below; severity/enforcement from `.oxlintrc.json` + inherited preset. Syntax/type checks ≠ lifetime, cancellation or authorization proof.

---

### 0. The Meta-Invariant: Control Plane vs. Utility Library

**NEVER: use Effect as an ad-hoc utility library inside imperative plumbing.**

- *Broken Invariant:* Independent runners inside domain execution do not automatically inherit fiber services, tracing or cancellation. Foreign callbacks/adapters alone do not create another Effect fiber; their owner must preserve context, cancellation and disposal.
- *Rule:* Ordinary pure helpers stay **pure TypeScript**. `Effect.sync` deliberately defers evaluation and turns synchronous throws into defects; eager replacement changes semantics. Impure domain execution stays **inside Effect** until owned host adapters: roots, request handlers, UI/foreign-framework boundaries.

---

### 1. Control Plane Escape & Re-entry

**NEVER: independent `runPromise` / `runSync` execution inside Effect programs. \[tsgo: `run-effect-inside-effect` — error]**

- *Broken Invariant:* Separate runners do not automatically inherit parent trace context, dynamic services (`Context`) or interruption. `async/await` in an owned foreign adapter is not itself a runtime escape.
- *Repair:* Stay within the pipeline (`yield*`, `flatMap`, `pipe`). Bridge foreign callback APIs with `Effect.callback` or `Effect.tryPromise`; propagate cancellation where supported.

**NEVER: use `Effect.sync` to await promises, or expect an already-executing promise to become lazy/retryable. \[tsgo: `lazy-promise-in-effect-sync`, `promise-in-effect-success` — errors]**

- *Broken Invariant:* `Effect.sync(() => promiseFactory())` delays the factory but succeeds with its Promise; no awaiting/rejection capture. Existing promises have already started; adaptation cannot defer or restart them.
- *Repair:* Fresh factory inside `Effect.tryPromise({ try: (signal) => promiseFactory(signal), catch: mapError })`; map expected failures, wire supported cancellation.

**NEVER: use JS `try/catch/finally` for yielded Effect recovery/cleanup, or return `Effect.fail` inside `try` mappers. \[tsgo: `try-catch-in-effect-gen` — warning; `effect-in-failure` — error]**

- *Broken Invariant:* JS handlers catch actual JS throws; unhandled yielded failures, defects/interruption do not resume these handlers. Returning an Effect inside an error mapper makes it the error payload. The diagnostic does not cover `finally`-only cleanup.
- *Repair:* Typed recovery: `Effect.catch`, `catchTag`, `catchIf`; cleanup: `ensuring`, `onExit`, resource brackets. Error mappers return error values; recovery handlers intentionally return Effects. Legitimate synchronous JS recovery remains valid; this broad diagnostic therefore warns.

---

### 2. Execution Laziness & Floating Computations

**NEVER: leave intended work unconsumed. AVOID redundant zero-argument Effect factories. \[tsgo: `floating-effect`, `return-effect-in-gen`, `missing-return-yield-star` — errors; `lazy-effect` — warning]**

- *Broken Invariant:* Effects describe work; construction ≠ execution. `map(() => effect)` / returning an Effect from `gen` succeeds with unexecuted computation-as-data. Zero-argument factories are redundant only when construction semantics stay unchanged.
- *Repair:* 0-arg accessors default to properties (`preview: Effect<A>`); factories may deliberately capture invocation-time state/instrumentation. Consume via `yield*`, `flatMap`, `return yield*`; nested Effects require an explicit computation-as-data contract.

---

### 3. Dependency Graphs & Service Encapsulation

**NEVER: assert away errors or service requirements. \[tsgo: `unsafe-effect-type-assertion` — error]**

- *Broken Invariant:* Narrowing `E` / `R` of `Effect`, `Stream` or `Layer` by cast conceals failures or missing capabilities; runtime unchanged.
- *Repair:* Handle failures, provide dependencies; retain inferred channels. A proven library-typing mismatch permits a documented local exception, not global disabling.

**AVOID: leaking implementation-level services into domain signatures. \[tsgo: `leaking-requirements` — warning]**

- *Broken Invariant:* If `UserRepository.get` exposes `Effect<User, DbError, SqlClient>`, callers are forced to know internal transport/persistence mechanics.
- *Repair:* Capture fixed infrastructure at construction (`Layer.effect(UserRepository, make)` consuming `SqlClient`). Preserve caller-owned identity, authorization, transaction participation and scopes in invocation requirements; do not capture the first caller's entire context merely to force `R` to `never`.

**NEVER: treat `Layer.mergeAll` as sequential initialization or dependency wiring.**

- *Broken Invariant:* `Layer.mergeAll` builds siblings concurrently; neither supplies their outputs to each other nor establishes initialization order/readiness. Dependent layers fail or race.
- *Repair:* Wire prerequisites via `Layer.provide` / `provideMerge`. Complete initialization before dependent work, or await an outcome-aware readiness barrier.

**AVOID: coupling domain logic to concrete infrastructure through local `Effect.provide`. \[Δ4]**

- *Broken Invariant:* Inlining fixed `LiveDatabase` couples business rules to infrastructure. V4 provision shares memoization context by default; nesting alone does not break sharing. Layer identity, context and lifetime determine sharing.
- *Repair:* Wire infrastructure at composition owners; local provision may select scoped implementations or test substitutes. `Layer.fresh` / `{ local: true }` deliberately isolate construction. `strict-effect-provide` is not enabled.

**AVOID: using `Context.Reference` where absence must fail. \[Δ4]**

- *Broken Invariant:* Default context values for identity, tenancy, or credentials conceal missing wiring by silently falling back.
- *Repair:* Use `Context.Service` (no default) for mandatory capabilities. `Context.Reference` needs a meaningful safe default, cached on its key; a mutable default object is not private fiber-local state. Override through context.

---

### 4. Error Stratification & Cause Fidelity

**NEVER: erase meaningful domain/library error distinctions via `any`, `unknown`, or generic `Error`. \[tsgo: `global-error-in-effect-failure` — warning]**

- *Broken Invariant:* Loses static discrimination/exhaustiveness in `E`; recovery becomes less precise. Foreign causes/untrusted input legitimately remain `unknown` until narrowed or wrapped.
- *Repair:* Preserve meaningful error types; schema-backed `Schema.TaggedError` for serializable contracts. Narrow/map foreign causes without erasing domain distinctions. `any-unknown-in-error-context` is disabled; general type rules: [TypeScript](../typescript.md).

**AVOID: converting recoverable domain errors into defects via early `orDie`.**

- *Broken Invariant:* Converts typed failures to defects, bypassing typed recovery. Defects remain observable/deliberately recoverable; process termination depends on host policy.
- *Repair:* Keep expected errors in `E`. Reserve `orDie` or untyped defects exclusively for broken system invariants and programmer bugs.

**NEVER: swallow interruption when recovering causes. \[Δ4]**

- *Broken Invariant:* Recovering cancellation as artificial success/fallback can prevent graceful teardown. Full-cause handlers do not automatically swallow every external interruption; observation ≠ recovery.
- *Repair:* Prefer `Effect.catchTag` / `catch` for typed errors. Full `Cause` recovery/transformation preserves interruption reasons (`Cause.reasons` `[Δ4]`), except an explicit cancellation protocol.

---

### 5. Scoping, Resource Ownership & Finalizers

**NEVER: leak scoped handles past `Effect.scoped`.**

- *Broken Invariant:* `Effect.scoped` executes finalizers upon exit. Returning a resource whose client, socket, or file handle is tied to that scope yields a closed, poisoned handle.
- *Repair:* Consume within the scope or return detached data; caller-owned lifetime retains `Scope`, actual acquisition errors and other requirements. Types alone do not prevent escaped handles.

**NEVER: allow an interruptible window between resource acquisition and finalizer registration.**

- *Broken Invariant:* `const res = acquire(); addFinalizer(res.close)` leaks if interruption hits between lines.
- *Repair:* Resource brackets/scoped constructors: `Effect.acquireRelease(acquire, release)` masks acquisition + registration by default. Interruptible acquisition must clean up partial resources itself; avoid indefinitely blocked non-cancellable acquisition. Correctly masked custom protocols may also establish the invariant.

---

### 6. Concurrency, Admission & Determinism

**NEVER: spawn detached background work without lifetime, shutdown and failure-observation ownership.**

- *Broken Invariant:* Unowned fibers can outlive callers; failures may go unobserved, shutdown/resource release lack an owner. Parent/scope ownership alone does not propagate failure into the caller's business flow.
- *Repair:* `forkChild`, `forkScoped`, explicit managers (`FiberMap`, `FiberSet`, `FiberHandle`); join, await or report failures deliberately. `forkDetach` needs ownership beyond the parent; no ownership diagnostic in this baseline.

**AVOID: unbounded concurrency across shared infrastructure.**

- *Broken Invariant:* Fibers are cheap; databases, sockets, and third-party APIs are not. Unbounded fan-out causes memory spikes and downstream denial-of-service.
- *Repair:* `{ concurrency: n }` bounds one traversal; shared `Semaphore`, `PartitionedSemaphore` or pool bounds aggregate admission. Queued demand/backpressure/rejection and temporal quotas need separate policy.

**NEVER: use ambient non-deterministic globals directly in domain effects. \[tsgo: `global-random-in-effect`, `global-timers-in-effect`, `crypto-random-uuid-in-effect` — errors]**

- *Broken Invariant:* `Date.now()`, `Math.random()`, `setTimeout`, and `crypto.randomUUID()` break deterministic testing and property exploration.
- *Repair:* `Clock` / `Effect.sleep`, `Random`, platform `Crypto`; `TestClock` controls Effect time only. Randomness/cryptography need separate test implementations; secrets/security-sensitive identifiers require cryptographic randomness. Deterministic date conversion ≠ ambient time read. Baseline `global-date-in-effect` also flags explicit date conversion: disabled. UUID diagnostic catches global `crypto.randomUUID`, not Node's named import; checks do not trace arbitrary helpers.

---

### 7. Data Boundaries & Anti-Reinvention

**NEVER: treat validated wire schemas as authorization or permissions.**

- *Broken Invariant:* A payload satisfying `Schema.Struct` proves shape validity, not user entitlement or mutation authorization.
- *Repair:* Schema validates data contracts; middleware (`HttpApiMiddleware`) and domain logic must enforce access policies.

**AVOID: hand-rolling machinery where native primitives exist.**

- *Ad-hoc retry loop* → `Schedule`; eligibility/budget ≠ mutation idempotency or retraction of observed output.
- *Ad-hoc cache with TTL* → `Cache` / `ScopedCache`; security-sensitive key inputs, deliberate failure caching; scoped eviction can close escaped handles.
- *Manual ref-counting* → `RcRef` / `RcMap`; borrower lifetime remains owned.
- *Cross-fiber atomic transactions* → `TxRef` / `Effect.tx` `[Δ4]`; whole invariant in one transaction, bodies can rerun: irreversible I/O outside; database/durable boundaries separate.
- *Ad-hoc pub/sub or queue* → `Queue` competing consumers / `PubSub` active-subscriber broadcast; capacity/loss/lifecycle explicit, neither supplies restart durability.
- *Dynamic service swapping* → `LayerRef` / `LayerMap`; invalidation clears borrow cache, not all layer memoization: active layer instances may be reused. Fresh generations need deliberate isolation; existing borrowers retain lifetime, immediate revocation needs separate policy.

---

### Triage / Review Checklist for Agents

When reviewing or generating code, check sequentially:

1. **Purity Check:** Pure helpers left alone? `Effect.sync` deliberately preserves deferred evaluation/defect semantics?
2. **Boundary Check:** Independent runners inside domain execution? Host adapters own context, cancellation, lifetime/disposal?
3. **Requirement Check:** Fixed infrastructure captured at construction? Caller-owned identity/transactions/scopes preserved in `R`?
4. **Error Check:** Meaningful typed error distinctions preserved? Foreign `unknown` narrowed/mapped? Expected outcomes kept out of defects?
5. **Lifetime Check:** Handles within owning scope? Acquisition/finalizer gap protected? Fork lifetime + failure observation owned?
6. **Saturation Check:** Shared-owner admission bounded, not merely each traversal? Demand/backpressure/quota policy explicit?