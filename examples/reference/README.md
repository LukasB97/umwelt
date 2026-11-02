# Reference app

Small host application on Umwelt. It compiles against `src` through the `@lukas.b97/umwelt` path in tsconfig; `test/reference.test.ts` deploys it and runs every function against Postgres.
It shows the whole surface in one place: defining Types, the migration chain, deploying, and using the Client.

```
umwelt/model.ts          the Types and the Client; the only hand-written description of the Model
umwelt/migrations/       the chain `umwelt create` writes; developers fill `migrate` where Check asks
deploy.ts                host's deploy step: Check, then Deploy
app/tracks.ts            Type with unique key: Identity, Write conditions, Query, relation read backwards, Delete
app/plays.ts             Type without unique key: Object ID, Get, Write by id, Delete by ids
app/playlists.ts         Type with history
app/host.ts              host foreign keys on Object IDs
app/promise.ts           host without Effect: the Promise face on a `pg` client
```

Typecheck from the repository root:

```sh
pnpm typecheck:reference
```
