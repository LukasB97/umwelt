/**
 * Umwelt's own tables. Hosts never see them, except `umwelt_object` for foreign keys on Object IDs.
 *
 * umwelt_object   id (Object ID, assigned by the database), type, identity (Identity as stored JSON, unique per type), payload,
 *                 created and changed (database time of create and of the last Write changing payload, in milliseconds,
 *                 so a Date read from them compares exactly)
 * umwelt_history  previous full payloads of Objects whose Type keeps history, in change order
 * umwelt_ledger   applied Migrations: position, id, hash
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Host foreign keys point here. Stable forever; only immediate, non-cascading constraints are seen by Delete. */
export const objectTable: { readonly name: "umwelt_object"; readonly id: "id"; readonly type: "type" } = {
    name: "umwelt_object",
    id: "id",
    type: "type"
}

/** SqlClient without the host's name and JSON transforms: Umwelt's columns and payloads are read as stored. */
export const umweltSql = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return sql.withoutTransforms()
})

/** `umwelt_object`, unless it exists; an existing one it does not lock. */
export const createObjects = Effect.flatMap(
    umweltSql,
    (sql) => sql`create table if not exists umwelt_object (
        id text primary key default gen_random_uuid()::text,
        type text not null,
        identity jsonb,
        payload jsonb not null,
        created timestamptz(3) not null default now(),
        changed timestamptz(3) not null default now()
    )`
)

/** Brings Umwelt's tables to the library's layout; idempotent. Deploy runs it, outside the chain. */
export const ensureLayout = Effect.gen(function* () {
    const sql = yield* umweltSql
    yield* createObjects
    yield* sql`create index if not exists umwelt_object_created on umwelt_object (type, created)`
    yield* sql`create index if not exists umwelt_object_changed on umwelt_object (type, changed)`
    // Identity of any size: the unique index holds its hash, since btree entries are limited; equality joins use the hash index.
    // `\` doubled, so the JSON text reaches bytea unchanged; `convert_to` is not immutable, so no index may use it.
    yield* sql`create unique index if not exists umwelt_object_identity on umwelt_object
        (type, sha256(replace(identity::text, '\\', '\\\\')::bytea))`
    yield* sql`create index if not exists umwelt_object_identity_lookup on umwelt_object using hash (identity)`
    yield* sql`create index if not exists umwelt_object_payload on umwelt_object using gin (payload jsonb_path_ops)`
    yield* sql`create table if not exists umwelt_history (
        position bigint generated always as identity primary key,
        object text not null references umwelt_object (id) on delete cascade,
        payload jsonb not null,
        replaced timestamptz not null default now()
    )`
    yield* sql`create index if not exists umwelt_history_object on umwelt_history (object, position)`
    yield* sql`create table if not exists umwelt_ledger (
        position integer primary key,
        id text not null unique,
        hash text not null,
        applied timestamptz not null default now()
    )`
})
