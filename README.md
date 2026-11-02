# Umwelt

[![CI](https://github.com/LukasB97/umwelt/actions/workflows/ci.yml/badge.svg)](https://github.com/LukasB97/umwelt/actions/workflows/ci.yml)

Umwelt stores typed objects in Postgres. A Type is an Effect Schema with a name; Umwelt stores Objects of that Type as JSON in tables it owns, validates every write against the schema, checks references between Objects, and migrates stored data when the Type changes. It is a library, not a service: it runs inside your application, on your database connection, inside your transactions.

Most applications describe their data in several places: the database schema, the migrations, the ORM model, the validation code, the TypeScript types. Every change touches all of them, and data already stored is moved along by a script written by hand. The copies drift, and stored data quietly stops matching what the code expects. Umwelt keeps one description, the Type in your code, and derives the rest from it: storage, validation, TypeScript types, JSON Schema, and the migration for every change.

## Getting started

Umwelt needs Node 24 or newer and Postgres.

```sh
npm install @lukas.b97/umwelt effect pg
```

Declare your Types in `umwelt/model.ts` and export the client made from them:

```ts
import { Schema } from "effect"
import { Umwelt } from "@lukas.b97/umwelt"
import migrations from "./migrations/index.ts"

export const Track = Umwelt.type(
    "Track",
    { slug: Schema.String, title: Schema.String },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)
export const Play = Umwelt.type("Play", { track: Umwelt.one("Track"), at: Schema.Date })
export const umwelt = Umwelt.make([Track, Play], { migrations })
```

A Type is an Effect Schema with a name. Nested structures, arrays, unions, and recursive shapes are allowed, and `typeof Track.Type` is its TypeScript type.

Write the first migration. Run this again after every change to your Types:

```sh
npx umwelt create initial
```

Deploy and use it:

```ts
import pg from "pg"
import { Play, umwelt } from "./umwelt/model.ts"

const db = umwelt.promise(new pg.Pool({ connectionString: process.env.DATABASE_URL }))

await db.deploy()
await db.Track.write({ data: { slug: "night-drive", title: "Night Drive" } })
await db.Play.write({ data: { track: { slug: "night-drive" }, at: new Date() } })
const { objects } = await db.Track.query({
    where: { slug: "night-drive" },
    include: { plays: Play.fields.track }
})
```

The query returns the track with its plays beside it, each with `id`, `createdAt`, `changedAt`, and `payload`.

[`examples/reference`](examples/reference) is a complete small application: a migration chain with a transforming step, a deploy step, and code with Promises and with Effect.

## Identity and relations

A unique key makes its fields the Object's Identity: a write with the same Identity addresses the same Object. A reference stores the target's Identity, so stored data reads on its own, and a reference must point at an Object that exists.

```ts
export const Playlist = Umwelt.type(
    "Playlist",
    { name: Schema.String, tracks: Umwelt.many("Track") },
    { uniqueKey: Schema.Struct({ name: Schema.String }), history: true }
)

await db.Playlist.write({ data: { name: "road-trip", tracks: [{ slug: "night-drive" }] } })
// stored: { "name": "road-trip", "tracks": [{ "slug": "night-drive" }] }

const { deleted, blocked } = await db.Track.delete({ where: { slug: "night-drive" } })
// deleted: [], blocked: the track and the playlist that points at it
```

`.sparse()` on a relation allows a missing target. Every Object also carries an Object ID, assigned by Umwelt and never changed, for your own tables and for Types without a unique key.

## Queries

`where` filters on fields and through relations, with `AND`, `OR`, and `NOT`. `include` fetches related Objects in both directions: the relation field itself, `Play.fields.track`, yields the plays pointing at a track.

```ts
await db.Play.query({
    where: { at: { gt: yesterday }, track: { is: { title: "Night Drive" } } },
    orderBy: { at: "desc" },
    take: 20,
    include: { track: true }
})

await db.Track.query({
    where: { slug: "night-drive" },
    include: { playlists: Playlist.fields.tracks, recentPlays: Play.fields.track.take(5) }
})
```

## Migrations

Change a Type and run `umwelt create`: Umwelt writes the migration from the difference. The migration files hold every old form of every Type, each linked to its parent by hash, like git history; your code holds only the current Types.

```ts
export const Track = Umwelt.type(
    "Track",
    { slug: Schema.String, title: Schema.String, seconds: Schema.Number },
    { uniqueKey: Schema.Struct({ slug: Schema.String }) }
)
```

```sh
npx umwelt create seconds
```

```ts
// umwelt/migrations/20261102-1015-seconds.ts, written by `umwelt create`
export default Umwelt.migration({
    id: "20261102-1015-seconds",
    parent: { id: "20261027-0910-initial", hash: "sha256:…" },
    types: {
        Track: Umwelt.step({
            // transforming
            before: { /* Track as JSON Schema, before */ },
            after: { /* Track as JSON Schema, after */ },
            migrate: (old) => ({ ...old, seconds: 0 })
        })
    }
})
```

Each change is safe, when stored content still fits; transforming, when it may not, and you fill in `migrate`; or destructive, when content is lost. `check` reports pending migrations and their kinds. `deploy` applies them in one transaction, history included, or applies nothing. After that, code and database must agree: operations against a database at another migration fail with `ModelMismatch`.

## History

Playlist above declares `history: true`: Umwelt keeps every previous state of its Objects, and migrations rewrite those states too.

```ts
await db.Playlist.history({ object: { name: "road-trip" } })
// previous states, in change order, each in the current schema
```

An `immutable` Type's Objects are written once; a correction is a new Object.

## Effect

In an Effect application, use `umwelt` directly: operations return Effects and run on the `SqlClient` in context, for example from `@effect/sql-pg`.

```ts
import { Effect } from "effect"
import { Play, umwelt } from "./umwelt/model.ts"

const program = Effect.gen(function* () {
    yield* umwelt.deploy()
    return yield* umwelt.Track.query({ where: { slug: "night-drive" }, include: { plays: Play.fields.track } })
})
```

Umwelt has no transaction API of its own. Inside your transaction, on the `SqlClient` or on the `pg` client given to `umwelt.promise`, its changes commit or roll back with yours.

## The name

In Jakob von Uexküll's biology, an organism's Umwelt is the part of the world it perceives, in its own terms. Umwelt holds the part of the world your application finds meaningful, in the terms your application declared.

## Specification

[`CONTEXT.md`](CONTEXT.md) is the full specification; code follows it. Its table points to the document for each topic.

## Contributing

```sh
git clone https://github.com/LukasB97/umwelt.git
cd umwelt
pnpm install
pnpm test
```

Tests need Docker; they start Postgres for the run. Behavior changes start in the specification: edit `.CONTEXT.source/`, render it with `pnpm context`, then change code. A pull request passes `pnpm check` and `pnpm test`.

## License

[MIT](LICENSE)
