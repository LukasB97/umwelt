/** Layer fixture: a fresh database on the test container, named per test file, dropped when the layer is released. */
import { PgClient } from "@effect/sql-pg"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import pg from "pg"
import { inject } from "vitest"

const urlOf = (name: string) => {
    const url = new URL(inject("databaseUrl"))
    url.pathname = `/umwelt_${name}`
    return url.href
}

export const TestDatabase = (name: string) =>
    Layer.unwrap(
        Effect.gen(function* () {
            const admin = yield* PgClient.makeClient({ url: Redacted.make(inject("databaseUrl")) })
            const database = admin(`umwelt_${name}`)
            yield* Effect.acquireRelease(admin`create database ${database}`, () =>
                Effect.orDie(admin`drop database ${database} with (force)`)
            )
            return PgClient.layer({ url: Redacted.make(urlOf(name)) })
        })
    ).pipe(Layer.provide(Reactivity.layer))

/** A `pg` client on the TestDatabase `name`, ended with the scope, for hosts without Effect. */
export const pgClient = (name: string) =>
    Effect.acquireRelease(
        Effect.promise(async () => {
            const client = new pg.Client({ connectionString: urlOf(name) })
            await client.connect()
            return client
        }),
        (client) => Effect.promise(() => client.end())
    )

/** A `pg` pool on the TestDatabase `name`, ended with the scope. */
export const pgPool = (name: string) =>
    Effect.acquireRelease(
        Effect.sync(() => new pg.Pool({ connectionString: urlOf(name) })),
        (pool) => Effect.promise(() => pool.end())
    )

/** What a Promise rejects with, as thrown; a Promise that resolves is a defect. */
export const rejection = (run: () => Promise<unknown>) =>
    Effect.promise(() =>
        run().then(
            () => Promise.reject(new Error("expected a rejection")),
            (error: unknown) => error
        )
    )

/** Waits until `count` statements on this database wait for locks other transactions hold. */
export const lockWaits = (count: number) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ count: number }>`select count(*)::int as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`
        return row?.count ?? 0
    }).pipe(Effect.repeat({ until: (waiting) => waiting >= count }))

/**
 * `first` runs in a transaction held open until `second`, on another connection, waits for a lock, or finishes without
 * waiting; then `first` commits. Both results, `second`'s as Exit, and whether `second` waited.
 */
export const concurrently = <A, B, E1, E2>(
    first: Effect.Effect<A, E1, SqlClient.SqlClient>,
    second: Effect.Effect<B, E2, SqlClient.SqlClient>
) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const done = yield* Deferred.make<void>()
        const commit = yield* Deferred.make<void>()
        const holding = sql.withTransaction(
            Effect.gen(function* () {
                const result = yield* first
                yield* Deferred.succeed(done, undefined)
                yield* Deferred.await(commit)
                return result
            })
        )
        const held = yield* Effect.forkChild(holding)
        yield* Deferred.await(done)
        const waiting = yield* Effect.forkChild(second)
        const waited = yield* Effect.raceFirst(Effect.as(lockWaits(1), true), Effect.as(Fiber.await(waiting), false))
        yield* Deferred.succeed(commit, undefined)
        return [yield* Fiber.join(held), yield* Fiber.await(waiting), waited] as const
    })
