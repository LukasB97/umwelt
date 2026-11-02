/**
 * The host's deploy step, run before new instances start.
 * Creating migrations happens at development time with `umwelt create <name>`; this applies them.
 */
import { Effect } from "effect"
import { umwelt } from "./umwelt/model"

export const deploy = Effect.gen(function* () {
    const change = yield* umwelt.check()
    for (const migration of change.pending) {
        const steps = Object.entries(migration.types).map(
            ([type, step]) => `${type} ${step.kind} (${step.objects} objects)`
        )
        yield* Effect.log(`pending ${migration.id}: ${steps.join(", ")}`)
    }
    for (const reason of change.blocking) yield* Effect.logError(`blocked: ${reason.kind}`)

    const { applied } = yield* umwelt.deploy()
    yield* Effect.log(`applied ${applied.length} migrations`)
}).pipe(
    Effect.catchTag("Blocked", (error) =>
        Effect.die(new Error(`deploy blocked: ${error.reasons.map((r) => r.kind).join(", ")}`))
    )
)
