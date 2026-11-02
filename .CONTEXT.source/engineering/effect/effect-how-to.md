---
order: 10
render_to: CONTEXT/engineering/effect/effect-how-to.md
read_when: "implementing services, I/O, state, concurrency or resource lifetimes and selecting the matching Effect primitives."
---
# Effect v4 architectural navigation

Audience: coding agents competent Effect v3.
Release baseline: `effect@4.0.0`, September 30, 2026. `[Δ4]` changed v3 model or mechanic. Installed exports, declarations, stability annotations take precedence over guide and mutable upstream sources. [^release] [^exports]

## 0. invariant

Before infrastructure, name invariant: shared identity, borrower lifetime, atomicity, admission fairness, readiness, representation fidelity, progress across restarts. Select primitive owns invariant. boundary: invocation, scope, process, durable execution. application policy around boundary rather than reproducing machinery. `AVOID:` common wrong route.

lockfile installed `effect/package.json` exports resolve names, inspect declarations, documentation, examples/tests. Read overloads when context capture, scope, failure, return shape affects composition. `LLMS.md`, `ai-docs/`, `migration/` locate surface. `AVOID:` inferring unlisted siblings from naming pattern. [^llms] [^migration-reference]

**[Δ4]** exports `effect/http`, `effect/http-api`, `effect/sql`, `effect/schema`, `effect/rpc`, `effect/ai`, `effect/workflow`, other families below. Former `effect/unstable/*` no compatibility exports. Stability `@stability`; some APIs can change minor or patch releases. Runtime-, driver-, provider-specific integrations separate packages. [^exports] [^migration] [^release]

## 1. dependency or construction effect

**implementations → `Context.Service` explicit `Layer`. [Δ4]** Shape: `Context.Service<Self, Shape>()(id)`; inferred `Context.Service<Self>()(id, { make })`; `Layer.effect(Service, make)`. Neither generates default layer or automatically provides dependencies. Yield service call methods; `Service.use` one-off access preserves generic/overloaded methods. [^services]

**collaborator fixed, caller policy varies → capture collaborator.** Resolve infrastructure dependencies constructing service. Keep identity, authorization, transaction participation, per-invocation requirements inside operation. `AVOID:` capturing entire first caller context merely to make every method's `R` `never`. [^services] [^runtime]

**contextual meaningful default → `Context.Reference`. [Δ4]** Shape: `Context.Reference<T>(id, { defaultValue })`. Fiber-local configuration context services rather than `FiberRef`. Override computation `Effect.provideService`. `AVOID:` set/reset machinery; assuming v3 fork/join merge. required `Context.Service` when default conceal missing capability. [^fiberref]

**Construction acquires resources, registers finalizers, starts owned work → `Layer.effect`. [Δ4]** supplies layer's scope removes `Scope` requirement. `Layer.effectDiscard` startup work provides no service. prerequisite work consuming layer's dependency graph. `AVOID:` treating merged layers as sequencing. [^layer]

**Configuration chooses implementation → `Layer.unwrap`.** layer effectfully instead of building context, another runtime, service-shaped switch. Construction-time selection not hot reconfiguration; refreshable resource or layer owner when replacement later. [^layer]

**Repeated provision → layer memoization. [Δ4]** Memoization can shared across `Effect.provide` boundaries within context. Preserve layer identity sharing. `Layer.fresh` or provision's `{ local: true }` isolation. `AVOID:` treating memoization as process-global singleton. [^memo]

## 2. map, TTL timer, disposal

**Memoize lookup results → `Cache`.** shares in-flight lookups stores successful and failed results. TTL from result when negative caching transient failures need different policies. key include every dimension changes answer. [^cache]

**Cache entries own resources → `ScopedCache`.** lookup entry scope; expiry, invalidation, eviction, owner shutdown can finalize. eviction-owned, not borrower-owned lifetime. [^scoped-cache]

**One resource → `RcRef`; one per key → `RcMap`.** track scoped borrowers. Idle TTL starts after last borrower releases. shared connections, subscriptions, tenant sessions, expensive scoped handles. [^rc-ref] [^rc-map]

**tenant/region service graph → `LayerMap`.** Cache borrow contexts from keyed layers. graph acquisition, sharing, invalidation, release inside layer owner. tenant-selected service graph different from unkeyed service reading request-local tenant identifier. [^layer-map]

**service graph invalidated or refreshed → `LayerRef`.** unkeyed, reference-counted layer owner. Invalidation clears borrow cache; active borrowers retain contexts. Shared layer memoization may reuse existing services on reacquisition (`LayerMap` likewise); fresh service generation requires deliberate isolation at replacement boundary (`Layer.fresh`). [^layer-ref] [^layer-map] [^memo]

**latest acquired value refresh manually or schedule → `Resource`.** configuration, credentials, resource-backed snapshots. Successful replacement releases previous acquisition; failed refresh leaves previous stored result intact. [^resource]

**bounded inventory reusable resources → `Pool`.** acquisition, checkout, invalidation, resizing, release. per-item concurrency limits: choose exclusive checkout when required. semaphore limits work; not resource inventory. [^pool]

**cache lookup depends services → `requireServicesAt`. [Δ4]** Construction-time and lookup-time service requirements alternatives. `AVOID:` assuming lookup-time context partitions cached results. Cross-tenant leakage possible when keys omit identity or authorization-sensitive inputs. [^cache]

## 3. fibers coordinate state or external system

**transactional reads writes → `TxRef` `Tx*` collections inside `Effect.tx`. [Δ4]** compose `Effect.gen`; no separate STM program commit. Enclose entire read/check/write invariant one transaction. Independently atomic operations not surrounding sequence atomic. [^tx]

**transaction wait until predicate true → `Effect.txRetry`.** tracks references read can retry when change. Transaction bodies can rerun on conflicts; irreversible I/O externally visible side effects outside. `AVOID:` polling, condition-variable registry, sleep loops; irreversible I/O inside retried body. neither database transaction nor durable workflow. [^tx] [^tx-effects]

**signal one result → `Deferred<A, E>`; gate repeatedly opens closes → `Latch`.** deferred shares success or failure every awaiter; `Deferred.done` transfers `Exit`, including defects interruption. `Latch.await`/`open`/`close` admission without error channel. `Latch.release` on closed gate wakes current waiters without opening; already open gate unchanged. [^deferred] [^latch]

**Startup before dependent work → constructor, or outcome-aware readiness barrier. [Δ4]** Shape: `Deferred.make` → child `Deferred.done`/`succeed` → parent `Deferred.await`; observe child `Fiber.await`/`join`. Complete initialization owning `Layer.effect` before forking ongoing work whenever possible; every pre-readiness termination must settle wait, including interruption before initialization starts. successful readiness signal leaves ongoing worker failure separate supervision concern. `AVOID:` sleeps or `{ startImmediately: true }` as readiness guarantees. [^forking] [^deferred] [^fiber]

**Unrelated callers batchable lookups → `Request` + `RequestResolver`. [Δ4]** batching shared resolver boundary. v4 resolver entries with request context completion handles. `setDelay` batching/latency tradeoff, `withCache` lookup reuse, `withSpan` links batch execution originating requests. Resolve individually. `AVOID:` losing per-request failures or contexts in untyped batch promise. [^batching]

**tenant monopolizes globally bounded capacity → `PartitionedSemaphore`.** schedules partitions fairly shared permit pool. not independent per-key mutexes not per-key serialization. [^partitioned]

**requests/tokens per interval, possibly across processes → `RateLimiter` from `effect/persistence`.** Fixed-window token-bucket policies share in-memory or Redis-backed store. Choose rejection, delay information, waiting according boundary's contract. concurrency semaphore not enforce temporal quota; in-memory store not coordinate multiple processes. [^rate-limiter]

**Background jobs identity → `FiberMap`; replaceable slot → `FiberHandle`; owned collection → `FiberSet`.** Delegate completion removal scope shutdown. `FiberMap` replacement versus only-if-missing admission. process-local owners, not durable job schedulers. [^fiber-map] [^core-index]

**values, failure, completion → `Queue<A, E>`. [Δ4]** typed lifecycle. Keep envelopes only when failures or terminal markers application data rather than queue control. `AVOID:` automatically porting v3 `Queue<Exit<...>>` or custom end-sentinel protocol. [^queue]

## 4. Retry, fallback, recovery

**success/failure value → `Result<A, E>`. [Δ4]** v3 `Either` becomes `Result`; `right`/`left` become `succeed`/`fail`, `Success`/`Failure` cases. Shape: `Result.succeed(value)` | `Result.fail(error)`. effectful operations `Effect<A, E, R>` until boundary needs failure as data. pure result neither service requirements nor complete fiber termination model. [^result] [^migration-reference]

**Typed outcomes or complete termination data.** `Effect.result` produces `Effect<Result<A, E>, never, R>` captures typed failures. `Effect.exit` produces `Exit<A, E>` full failure cause. Promise boundary, `runPromise` returns successful value or rejects; `runPromiseExit` returns `Exit`. [^effect] [^exit]

**Recovery failure kind → select channel before tags. [Δ4]** Shape: `Effect.catchTag("Tag", handler)`; `Effect.catchReason("ErrorTag", "ReasonTag", handler)`. Inside `E`, `catchTag`/`catchTags` discriminants, `catchIf` predicate, `catchFilter` pass/fail transformation, `catch` all typed errors. `catchDefect` deliberate defect recovery; `catchCause`/`catchCauseFilter` full causes. Keep interruption propagation explicit; reporting `onExit` need not turn cancellation into recovery. [^error-handling] [^effect] [^cause]

**typed error serializable contract → `Schema.TaggedError`.** Shape: `Schema.TaggedError<Self>()(tag, fields)`, optionally identifier first call. schema-backed yieldable error class. same error schema RPC, HTTP, persisted-activity boundaries. [^schema]

**operation temporal repetition policy → `Schedule`. [Δ4]** attempt/timing metadata `Schedule.CurrentMetadata`. Schedules own error service parameters; fallible policy not necessarily representable old three-parameter assumptions. `AVOID:` parallel retry counters, start timestamps, elapsed-time refs. [^schedule]

**Different providers different retry budgets eligibility → `ExecutionPlan`.** ordered steps context/layer provision, attempts, schedules, conditions. `Effect.withExecutionPlan` or `Stream.withExecutionPlan`. general provider/resource failover, not AI-only. `AVOID:` nested catches and reconstructing clients every branch. [^execution-plan]

**retry → narrow boundary before policy.** Neither `Schedule` nor `ExecutionPlan` makes operation idempotent or retracts stream elements observed. Retrying read, activity, replaying partially emitted response different contracts. [^execution-plan] [^activity]

**stable category actionable reasons → reason-based errors. [Δ4]** Preserve outer tagged error tagged `reason`. pipeable `Effect.catchReason(errorTag, reasonTag, handler)` `Effect.catchReasons(errorTag, cases)`; handlers receive selected reason parent error. Handling reason alone retains parent error type default overload. `unwrapReason` intentionally exposing reasons as boundary's error union. [^error-handling] [^effect]

**Filtering retain rejected information or transform accepted values → `Filter`. [Δ4]** pass/fail representation consumers `Effect.catchFilter`; rejected branch information `Predicate` or `Option` discard. `AVOID:` boolean test + unsafe narrowing + second transformation repeating decision. [^filter]

**Failure reporting cause structure → flat `Cause.reasons`. [Δ4]** failure, defect, interruption reasons current guards combinators. old temporal/concurrent topology not present. `AVOID:` porting recursive `Sequential`/`Parallel` tree walkers. [^cause]

## 5. data contract boundaries

**domain value different external representation → codec, not parallel DTO parser. [Δ4]** Preserve both sides requirements `Schema.Codec`; `Schema.toType` or `toEncoded` only intentionally projecting away other side. type-only annotation can erase information required serialization or schema derivation. [^schema]

**same conversion across schemas → `SchemaTransformation`. [Δ4]** Transformations independent, composable, reversible-direction descriptions, attached `Schema.decodeTo`. `SchemaGetter` when one direction handle presence/absence, failure, services. `AVOID:` repeating whole-struct decoding functions. [^transformation] [^getter]

**Fields structural edits → `.mapFields(...)` `Struct` field combinators.** Structs, supported opaque structs, schema classes; result new `Schema.Struct`. Whole-struct checks dropped by default. field projection explicit decision cross-field invariants class behavior. `AVOID:` `{ unsafePreserveChecks: true }` before verifying every check against changed shape. [^schema-guide] [^schema]

**Only wire field names differ → `Schema.encodeKeys({ decodedKey: encodedKey })`.** Assemble complete fields-bearing schema first, then encoded-key mapping. structural field renaming when domain keys change; explicit transformation when representation change more than key names. [^schema-guide] [^schema]

**Computed domain values wire → explicit output schema transformation.** class getter not declare serialized field. computed field part encoded contract map deliberately, test encoding actual instance. Property lookup field selection separate: parser can read declared inherited properties. [^schema-ast] [^transformation]

**Validation representation changes → separate checks from transformations.** schema checks admissibility transformations conversion. Give reusable checks annotations downstream interpreters need; runtime predicate alone not explain semantics JSON Schema generation, arbitrary generation, other tooling. [^schema] [^representation]

**PATCH, defaults, optional fields distinguish absence from `undefined` → key-aware schema operations. [Δ4]** `optionalKey`, optional getters/transformations, decoding-default family. Decide default encoded or decoded side. `AVOID:` collapsing “absent,” “present with undefined,” “present with null” through generic cleanup. [^schema-guide] [^transformation]

**Rich values JSON or string-based boundaries → canonical codecs. [Δ4]** `Schema.toCodecJson` canonical string/tree/form-related facilities instead of `JSON.stringify` reviver registry. derivation traverses nested schemas. Custom declarations need explicit representation strategy; TypeScript type serializable-looking not codec. [^schema-guide]

**Select/insert/update/public/create/patch views differ → `Model` `VariantSchema` from `effect/schema`.** field variants `Field`, `FieldOnly`, `FieldExcept`; derive views. `AVOID:` duplicating near-identical schemas; forcing independently evolving business contracts into universal model because fields match. [^sql-example] [^schema-index]

**third-party library accepts Standard Schema → `Schema.toStandardSchemaV1`.** Adapt existing schema. Treat encoded input versus decoded output deliberately when transforms involved. [^schema-guide]

**schema tooling, persistence, import/export, code generation → `SchemaRepresentation` `JsonSchema`.** open representation document/code conversion before private AST nodes. Persisted opaque declarations/checks require explicit identities revivers. JSON Schema import/export supported subsets approximation semantics; cannot preserve arbitrary executable validation logic. [^representation]

**Validation demonstrably hot path → `SchemaJITCompiler` / `SchemaAOTCompiler` from `effect/schema`.** JIT explicitly enabled; environments forbid dynamic code generation need build-time route supported target set. [^schema-index] [^schema-guide]

## 6. services, clients, transports

**own HTTP contract → `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`.** Define schemas, success/error responses, middleware requirements shared contract. Derive handler requirements, typed clients, OpenAPI. Keep contract modules importable without server implementations, database drivers, live layers into clients. [^http-api]

**Authentication handlers require → `HttpApiMiddleware` or `RpcMiddleware`.** middleware's provided services declared failures part contract. client server middleware respective boundaries instead of scattering header parsing optional-user checks through business methods. [^http-api] [^rpc]

**Authentication schemes match generated clients OpenAPI → `HttpApiSecurity` middleware `security` configuration.** Declare `bearer`, `basic`, `apiKey({ key, in })` `HttpApiMiddleware.Service` options. Header/query/cookie extraction documented scheme share contract. middleware implementation verifies credentials supplies authenticated services; authorization attached protected operation. [^http-security] [^http-middleware]

**same API Node/Bun or Fetch-style host → `HttpRouter` route layers. [Δ4]** `HttpApiBuilder` supplies routes; `HttpRouter.serve` attaches server adapter, `HttpRouter.toWebHandler` supplies web handler disposal boundary. [^http-api]

**consume someone else's HTTP API → `HttpClient` request/response combinators.** Assemble base URL, authentication, response schemas, policies once around client. `HttpClient.retryTransient` policy entry point, not proof replaying mutation safe. `AVOID:` application-wide `fetch` wrapper before checking extension points. [^http-client]

**typed procedures, including streaming, rather than public REST → `Rpc`, `RpcGroup`, `RpcClient`, `RpcServer`.** procedure schemas independent protocol selection. Cluster entities reuse RPC contracts. `AVOID:` inventing request IDs, response envelopes, cancellation messages, stream framing before inspecting RPC transport/serialization. [^rpc] [^cluster-example]

## 7. Persistence

**SQL input encoding row decoding repeat → `SqlSchema`.** request/result schemas around query once instead of manually decoding each result. result-shape helpers zero/one/many-row semantics explicit. [^sql-schema]

**model ordinary CRUD batched lookup → `SqlModel.makeRepository` `SqlModel`/`SqlResolver` helpers.** `Model` `effect/schema`; SQL derivation `effect/sql`. Derive conventional behavior from variants, explicit SQL nonconventional queries. `AVOID:` treating supplied repository subset as full ORM. [^sql-model]

**service calls share database transaction → `sql.withTransaction` on `SqlClient`.** operations participate SQL client's contextual transaction machinery instead of threading raw connections through every service interface. distinct from `Effect.tx`: atomicity one not enlist other or cover remote side effects. [^sql-client]

**Service startup requires ready schema → Umwelt Deploy.** Deploy owns Umwelt's tables; no parallel Effect `Migrator`. Complete required schema work before dependent services; unrelated startup fiber not readiness guarantee. [Deploy](../../client/deploy.md)

**Values or lookup results survive process restart → `KeyValueStore`, `Persistence`, `Persistable`, `PersistedCache`.** `effect/persistence` before file/Redis serialization wrappers or homegrown persistent cache. durable cache not work queue, workflow journal, authoritative model business state. [^persistence]

## 8. Work survive fiber or process

**background handoff durable delivery retry → `PersistedQueue`.** named schema-encoded queues, store implementations, ID-based deduplication, attempts, processing acknowledgement. Restart survival requires durable store; `layerStoreMemory` volatile, Redis/SQL durability depends storage configuration. Delivery at-least-once: crash after side effect before acknowledgement can repeat handler. idempotent processing; deduplicating enqueue IDs not eliminate acknowledgement gap. [^persisted-queue]

**multistep operation resume completed progress → `Workflow` + `Activity` + `WorkflowEngine`.** activity's stable name success/error schemas identify persistable result. Choose engine/storage configuration provides required durability; `ClusterWorkflowEngine` connects workflow execution cluster sharding message storage. `AVOID:` wrapping whole procedure in retry or status-columns-plus-custom-interpreter. [^activity] [^workflow] [^cluster-workflow]

**Replay preserve timestamp, generated ID, external read, branch input → workflow payload or named `Activity` result.** Derive stable values from recorded inputs; acquire changing values inside activity's lazy `execute` effect. Shape: `Activity.make({ name, success, error, execute })`. Keep names stable distinct different logical occurrences. `AVOID:` ambient random/time API before activity boundary. [^activity] [^workflow]

**resumed operation waits time, signal, queued input → `DurableClock`, `DurableDeferred`, `DurableQueue`.** clock call `DurableClock.sleep({ name, duration })`. optional `inMemoryThreshold` defaults 60 seconds; sleeps at or below use in-memory activity, longer sleeps engine's scheduled clock. Choose threshold deliberately when restart behavior matters. Durable deferreds/queues workflow coordination; `PersistedQueue` general durable work delivery. [^durable-clock] [^workflow-index]

**unfinished activity may repeat side effect → `Activity.idempotencyKey(name)` plus external deduplication.** stored result can replayed; execution not durably completed can run again. Keep same key retries same logical mutation. `{ includeAttempt: true }` makes keys attempt-specific therefore unsuitable deduplicating mutation across attempts. remote system must honor key. [^activity]

**successful step compensation if workflow later fails → `Workflow.withCompensation`.** Register compensation around top-level workflow step; not work nested activities. `Workflow.addFinalizer` workflow-terminal work rather than assuming attempt-local `Effect.onExit` observes every workflow interruption. Compensation application-defined corrective work, not automatic rollback. [^workflow]

**Long-lived mutable behavior addressed business identity → cluster `Entity`.** Define RPCs let cluster route calls manage activation/passivation. Per-entity handlers sequential by default; `Rpc.fork` concurrent handling. `AVOID:` sharding registry + keyed actor mailboxes before checking entity runtime. [^cluster-example]

**entity recover after passivation or failure → persist messages and state deliberately.** Messages volatile by default; `ClusterSchema.Persisted` opts RPCs into message persistence. `Ref` inside entity in-memory state. Persisting messages not persisting arbitrary handler state or automatically reconstructing after reactivation. [^cluster-example]

**Entity routing across machines → `Sharding` cluster's runner/storage layers.** deployment placement `Sharding`/`ShardingConfig`; runner registration liveness `RunnerStorage`; persisted requests replies `MessageStorage`. infrastructure below `Entity`/RPC contract. Choose transport persistent adapters deployment instead of treating runner discovery as message durability. [^sharding] [^runner-storage] [^message-storage]

**recurring job cluster, not each replica → `ClusterCron`.** coordinates scheduling singleton persisted entity messages. Cluster ownership not make job’s external effects exactly-once. [^cluster-cron]

**Typed event history replica synchronization → `EventGroup`, `EventLog`, `EventJournal`, remote/server modules.** runtime combines handlers, journal, identity, replication, reactivity. not logging or transient `PubSub`, not introduced solely because table records past changes. [^eventlog]

## 9. async generator, pump loop, framing parser

**source structure → matching Stream constructor.** Cursor pagination `Stream.paginate`; callback APIs `Stream.callback`; async iterables `fromAsyncIterable`; repeated polling `fromEffectSchedule`. Preserve source's failure, cancellation, resource ownership instead of normalizing into promise-producing loop. [^stream-create]

**stages buffering, grouping, merging, consumption → `Stream`/`Sink` until terminal boundary.** explicit queue when establishes asynchronous ownership or admission boundary. `AVOID:` materializing whole stream into arrays or inserting queues merely to connect composable stages. [^stream-consume] [^queue]

**fast producer bounded behind slow consumer → `Stream.buffer({ capacity, strategy })`.** `suspend` backpressure; `dropping` `sliding` deliberately lose data at capacity. `buffer` counts elements breaks chunking; `bufferArray` counts chunks preserves. Choose capacity unit loss policy before buffer. chunk bound cannot guarantee byte-memory bound when chunk sizes vary. [^stream]

**Bytes record framing schema-aware encoding → `effect/encoding`.** `Ndjson`, `Sse`, `SchemaBinary`, connect channels `Stream.pipeThroughChannel`. Network chunks not record boundaries. `AVOID:` concatenation buffer + line splitting that reimplements framing, partial input, failure semantics. [^encoding] [^stream-encoding]

**new stream operator or protocol adapter → `Pull` pull-transforming `Channel`. [Δ4]** Shape: `Channel.fromTransform` / `transformPull`: transform upstream pull into downstream pull under scope. Keep terminal completion distinct typed failure. `AVOID:` mechanically porting v3 channel interpreters / recursive instruction trees. [^channel]

**socket or worker, not just async function → `effect/socket` or `effect/workers`.** Inspect `Socket` worker/runner abstractions before building connection ownership, request tracking, pool management. Worker messages transfer buffers `Transferable`. Keep application contract above platform adapter. [^socket] [^workers]

## 10. AI integration

**Provider-neutral generation, structured output, streaming → `LanguageModel`; embeddings → `EmbeddingModel`.** business operations against model service supply provider implementations layers. core `ExecutionPlan` provider/model alternatives. `Chat` conversation state; conversation state not automatically durable workflow state. `AVOID:` independent provider fallback framework. [^ai-index] [^ai-model] [^execution-plan]

**Tools typed parameters, results, dependencies, handlers → `Tool` + `Toolkit`.** Declare schemas once, implement handlers layers, attach toolkit model operations. Choose tool failure fail enclosing operation or become tool result. Authorization, confirmation, business idempotency application policies. `AVOID:` treating schema-valid arguments as authorization. [^ai-tools]

**classification, rating, probability assessment one input → `Decision` + `DecisionModel`.** named decisions validated answers instead of bespoke prompt/output protocol one call per question. Valid probability-shaped output not evidence calibrated uncertainty. [^decision]

**capabilities exposed through MCP → `McpServer` AI protocol/tooling modules.** existing integration before unrelated tool schemas protocol handlers. Keep capability implementation separate from model-provider or MCP exposure. [^ai-index]

## 11. Reactive reads mutations

**Effects/streams observable application state → `Atom` + `AtomRegistry`.** registry owns evaluation, dependency tracking, current values, cleanup unused atoms. `AtomHttpApi`, `AtomRpc`, `Hydration` before second query-binding hydration layer. optional architectural choice. [^atom] [^reactivity-index]

**Refresh retain existing value or failure → `AsyncResult`.** initial/success/failure state independent waiting flag avoid inconsistent loading/data/error booleans. result lifecycle; not transport or persistence mechanism. [^async-result]

**Writes rerun dependent reads → `Reactivity`.** connects mutation success invalidation keys can batch notifications. not cache values process-local. invalidation after commit boundary; distributed system needs propagate invalidations between processes. [^reactivity]

## 12. Platform integration

**non-Effect host owns application lifecycle → `ManagedRuntime`.** Create managed layer graph host's ownership boundary dispose there. `AVOID:` runtime per repository method; unowned global runtime to suppress requirements. [^managed-runtime]

**callback execute already acquired environment → capture `Context` `Effect.run*With`. [Δ4]** Generic `Runtime<R>` gone; `Runtime` module process lifecycle. Prefer scoped runner such as fiber owner's runtime helper when callback's work belong owner. Capturing services alone not establish resource lifetime. [^runtime] [^fiber-map]

**Application lifetime running graph → `Layer.launch` platform `runMain`; task lifetime → matching fork owner. [Δ4]** `forkChild` parent fiber, `forkScoped` ambient scope, `forkIn(scope)` explicit scope. `forkDetach` survives caller completion needs deliberate supervision shutdown ownership. Keep returned scoped worker's owner open. Forks start deferred by default; readiness route §3 when initialization order matters. [^forking] [^layer]

**Portability or testability OS access → core `FileSystem`, `Path`, `Terminal`, `Stdio`, `Crypto`, platform layers.** subprocess pipelines, `ChildProcess` / `ChildProcessSpawner` `effect/process`; CLI parsing, `Command`, `Argument`, `Flag` `effect/cli`. `AVOID:` duplicating cancellation, process streaming, argument validation, platform switching in application wrappers. [^core-index] [^llms]

**Secure randomness, UUID generation, digests portable service → core `Crypto`.** `Crypto.Crypto` from context `randomBytes`, `randomUUIDv4`, `randomUUIDv7`, `digest` methods. Structural `Hash` values collection bucketing equality-related machinery, not cryptographic integrity. Check platform adapter's capabilities before application-wide cryptography wrapper. [^crypto] [^hash]

**Configuration sources vary → `Config` + `ConfigProvider`.** source selection conversion at configuration boundary rather than environment access across services. Keep secret-bearing values redacted through logging/inspection, not merely initial loading. [^core-index] [^llms]

## 13. evidence architecture works

**Tracing wrapping every method → named `Effect.fn` meaningful operation boundaries.** `fnUntraced` where reusable function not create own tracing boundary. Attach domain attributes without obscuring spans supplied HTTP, SQL, RPC, batching, AI integrations. [^llms] [^observability]

**Telemetry export → `effect/observability` OTLP layers, or `@effect/opentelemetry` existing OpenTelemetry setup.** Provide observability early enough observe layer construction. `AVOID:` custom exporter or manual span-context propagation through Effect-native service interfaces. [^observability] [^llms]

**service graph tests → `@effect/vitest` layer fixtures test services.** Shared `layer(...)` fixtures share state within block. separate provision when tests need independent mutable resources. Temporal tests test clock `effect/testing`, not wall-clock sleeps. [^layer-tests] [^tests]

**HTTP contract integration test without listening port → `HttpApiTest`.** request encoding, routing, handlers, middleware, response decoding through in-memory typed client. Cluster `TestRunner`. [^http-tests] [^cluster-example]

**Schemas values invariants explored → `Arbitrary.schema` native sample/check APIs. [Δ4]** Derive generated inputs shrinking/replay instead of parallel fixture generator. `AVOID:` assuming v3 fast-check re-export or old Schema arbitrary API remains current integration point. [^arbitrary]

**guarantee depends changed execution or encoding mechanics → test boundary directly.** startup failure cancellation before readiness, eviction while resource borrowed, actual encoded class output, replay after activity interruption. test services engine/transport fixtures appropriate boundary. Compilation checks API shape; tests check ownership, representation, recovery assumptions used select. [^tests] [^deferred] [^activity] [^schema-guide]

## 14. Small problem shapes

**Bytes text encodings → `Base64`, `Base64Url`, `Hex` from `effect/encoding`.** encoding module boundary; framing routes §9 NDJSON/SSE/binary records. Encoding, framing, buffering different problems. [^encoding]

**Payload limits or storage quantities exact units → core `ByteSize`.** SI/IEC parsing, formatting, comparisons, exact byte arithmetic instead of scattered unit multipliers. byte count, not byte-buffer abstraction. limit `ByteSize` needs enforcement producer, parser, storage boundary. [^byte-size]

**Nested immutable access or schema-backed patches → `Optic`, `JsonPointer`, `JsonPatch`, Schema-derived optics/differs.** before inventing dotted-path traversal, recursive update utilities, private patch protocol. [^schema] [^core-index]

**Dependency graphs, traversal, path finding, graph export → `Graph`.** Keep node identity distinct array offsets. before mutable adjacency-map abstraction solely standard algorithms. [^graph]

**IP addresses, interfaces, CIDR relationships → `NetAddress`, `IpInterface`, `IpNetwork` under `effect/net`.** `AVOID:` string splitting or hand-coded address arithmetic. [^net]

**Structural equality reason wrapper objects → reconsider. [Δ4]** `Equal.equals` compares plain objects, arrays, supported built-ins structurally by default. Equality/hash results cached; do not mutate compared/hashed objects. Keep custom identity when domain semantics require; `Equal.byReference` reference identity for identity-sensitive resources. [^equality]

**[Δ4]** `Yieldable` not Effect subtyping. Shape: `.asEffect()` where supported; `Ref` read, `Deferred` await, `Fiber` join. `AVOID:` casts erasing distinction. [^yieldable]

## 15. Compose routes; not collapse responsibilities

**Multitenant backend.** request identity invocation context; borrow expensive tenant-specific service graphs `LayerMap`; `PartitionedSemaphore` fair shared capacity; tenant-complete cache keys.

**Schema-first service.** contract modules implementation-free; derive model variants; `SqlSchema`/`SqlModel` persistence boundaries `HttpApi`/`Rpc` transport boundaries. Share source of truth for rule, not every representation same fields.

**Crash-resumable integration.** `PersistedQueue` handoff, `Workflow` recoverable multistep progress, `Activity` replay boundaries, external system's idempotency mechanism repeated side effects. None automatically creates atomic transaction across database, queue, remote API.

**Reactive integration.** remote contract `HttpApi`/`Rpc`, observable evaluation atoms, invalidation `Reactivity`, restart guarantees persistence/workflow infrastructure. “Reactive,” “cached,” “durable” independent properties.

helper deserves scrutiny when most code manages keys, scopes, timers, retries, response envelopes, schema projections, progress records. Search corresponding route before implementing. Preserve primitive's lifetime, failure, representation, replay boundaries abstraction.

---

References are in this [File](effect-how-to-refs.md)