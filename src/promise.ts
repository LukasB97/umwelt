/**
 * Promise face: the Effect face's operations and delegates with Promise results, failures thrown as the same classes.
 * Operations run on one SqlClient made from the host's executor, so SQL runs on the host's connection or transaction.
 */
import { Effect, Semaphore, Stream, type Scope } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, SqlError, Statement, type SqlConnection } from "effect/sql"
import type { Lender, Queryable, Run, SqlExecutor } from "./api.ts"

type Rows = readonly unknown[]
type Connection = SqlConnection.Connection
type Operation = (input: unknown) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>

/** Operations and Type delegates of the Effect face, by name. */
export type EffectFace = { readonly [name: string]: Operation | { readonly [name: string]: Operation } }

const failed = (cause: unknown) =>
    new SqlError.SqlError({
        reason: new SqlError.UnknownError({ cause, message: "Executor failed", operation: "query" })
    })

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
    typeof value === "object" && value !== null

/** Statements on one executor. Rows come as the executor gives them; this client never transforms them. */
const connectionOf = (run: Run): Connection => {
    const rows = (sql: string, parameters: readonly unknown[]) =>
        Effect.tryPromise({ try: () => run(sql, parameters), catch: failed })
    const values = (sql: string, parameters: readonly unknown[]) =>
        Effect.map(rows(sql, parameters), (result) => result.map((row) => (isRecord(row) ? Object.values(row) : [])))
    return {
        execute: rows,
        executeUnprepared: rows,
        executeRaw: rows,
        executeValues: values,
        executeValuesUnprepared: values,
        executeStream: (sql, parameters) => Stream.fromIterableEffect(rows(sql, parameters))
    }
}

const runOf = (executor: Queryable | Run): Run =>
    typeof executor === "function"
        ? executor
        : (sql, parameters) => executor.query(sql, parameters).then(({ rows }) => rows)

/** A connection of the pool for one transaction, back to the pool when the transaction ends. */
const checkout = (pool: Lender) =>
    Effect.map(
        Effect.acquireRelease(Effect.tryPromise({ try: () => pool.connect(), catch: failed }), (client) =>
            Effect.sync(() => client.release())
        ),
        (client) => connectionOf(runOf(client))
    )

const statement = (connection: Connection, sql: string): Effect.Effect<Rows, SqlError.SqlError> =>
    connection.executeUnprepared(sql, [], undefined)

/** Inside a transaction block, a transaction-local setting outlives the statement that set it; outside, it does not. */
const insideTransaction = (connection: Connection) =>
    Effect.gen(function* () {
        yield* statement(connection, "select set_config('umwelt.open', 'yes', true)")
        const [row] = yield* statement(connection, "select current_setting('umwelt.open', true) as open")
        return isRecord(row) && row["open"] === "yes"
    })

/**
 * Umwelt's top-level transaction: own `begin` and `commit`, or, on a connection inside the host's transaction,
 * a savepoint in it, so Umwelt's changes commit or roll back with the host's and a failure leaves nothing behind.
 * `lease` gives a fresh connection object per transaction, so `nested` marks one transaction only.
 */
const transactions = (
    client: SqlClient.SqlClient,
    lease: Effect.Effect<Connection, SqlError.SqlError, Scope.Scope>,
    hostable: boolean
) => {
    const nested = new WeakSet<Connection>()
    const savepoint = (id: number) => `umwelt_${id}`
    const run = (connection: Connection, sql: string) => Effect.asVoid(statement(connection, sql))
    const rollbackSavepoint = (connection: Connection, id: number) =>
        run(connection, `rollback to savepoint ${savepoint(id)}`)
    return SqlClient.makeWithTransaction({
        transactionService: client.transactionService,
        spanAttributes: [],
        acquireConnection: (restore) => restore(lease),
        begin: (connection) =>
            Effect.flatMap(hostable ? insideTransaction(connection) : Effect.succeed(false), (inside) => {
                if (inside) nested.add(connection)
                return run(connection, inside ? `savepoint ${savepoint(0)}` : "begin")
            }),
        savepoint: (connection, id) => run(connection, `savepoint ${savepoint(id)}`),
        releaseSavepoint: (connection, id) => run(connection, `release savepoint ${savepoint(id)}`),
        rollbackSavepoint,
        commit: (connection) =>
            run(connection, nested.has(connection) ? `release savepoint ${savepoint(0)}` : "commit"),
        rollback: (connection) =>
            nested.has(connection)
                ? Effect.andThen(rollbackSavepoint(connection, 0), run(connection, `release savepoint ${savepoint(0)}`))
                : run(connection, "rollback")
    })
}

/** Postgres placeholders and identifiers; Umwelt's SQL uses neither record updates nor custom fragments. */
const compiler = Statement.makeCompiler({
    dialect: "pg",
    placeholder: (index) => `$${index}`,
    onIdentifier: Statement.defaultEscape('"'),
    onRecordUpdate: () => ["", []],
    onCustom: () => ["", []]
})

/** A pool lends one connection per transaction; any other executor is one connection, maybe inside the host's transaction. */
const sqlClientOf = (executor: SqlExecutor) => {
    const run = runOf(executor)
    const pool = "totalCount" in executor ? executor : undefined
    const lease = pool === undefined ? Effect.sync(() => connectionOf(run)) : checkout(pool)
    return SqlClient.make({
        acquirer: Effect.succeed(connectionOf(run)),
        transactionAcquirer: lease,
        compiler,
        driver: "umwelt",
        spanAttributes: []
    }).pipe(
        Effect.map((client) =>
            Object.assign(client, { withTransaction: transactions(client, lease, pool === undefined) })
        ),
        Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make)
    )
}

/**
 * One permit per executor value, shared by every Client given it: two operations on one connection would share its
 * transaction. Host passes one executor value per connection, see Client.
 */
const permits = new WeakMap<Queryable | Run, Semaphore.Semaphore>()

const permitOf = (executor: Queryable | Run) => {
    const known = permits.get(executor)
    if (known !== undefined) return known
    const permit = Semaphore.makeUnsafe(1)
    permits.set(executor, permit)
    return permit
}

/** The Effect face on Promises: each call runs its operation to completion on the SqlClient over `executor`, one at a time per executor value. */
export const promised = (face: EffectFace, executor: SqlExecutor) => {
    const client = Effect.runSync(sqlClientOf(executor))
    const serial = "totalCount" in executor ? undefined : permitOf(executor)
    const run = (operation: Operation) => (input: unknown) => {
        const provided = Effect.provideService(operation(input), SqlClient.SqlClient, client)
        return Effect.runPromise(serial === undefined ? provided : serial.withPermit(provided))
    }
    const delegate = (operations: { readonly [name: string]: Operation }) =>
        Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, run(operation)]))
    return Object.fromEntries(
        Object.entries(face).map(([name, member]) => [
            name,
            typeof member === "function" ? run(member) : delegate(member)
        ])
    )
}
