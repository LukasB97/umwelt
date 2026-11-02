#!/usr/bin/env node
/**
 * `umwelt create <name>`, run where `umwelt/model.ts` lies: that module exports the Client, which knows Model and chain;
 * the chain's files live in `umwelt/migrations/`, `index.ts` listing them. Loads TypeScript through Node's type stripping.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { registerHooks, type ResolveHookSync } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { indexFile, isClient, isMigrationName, migrationFile, modelKey, nextMigration } from "./create.ts"

const relative = /^\.\.?\//u

/** Bundler-style relative imports without extension, like `./migrations`, as host projects write them. */
const resolve: ResolveHookSync = (specifier, context, next) => {
    try {
        return next(specifier, context)
    } catch (error) {
        const candidates = relative.test(specifier) ? [`${specifier}.ts`, `${specifier}/index.ts`] : []
        for (const candidate of candidates) {
            try {
                return next(candidate, context)
            } catch {
                continue
            }
        }
        throw error
    }
}

const create = async (name: string) => {
    const directory = join(process.cwd(), "umwelt")
    const migrations = join(directory, "migrations")
    const index = join(migrations, "index.ts")
    if (!existsSync(index)) {
        mkdirSync(migrations, { recursive: true })
        writeFileSync(index, indexFile([]))
    }
    registerHooks({ resolve })
    const exported: unknown = await import(pathToFileURL(join(directory, "model.ts")).href)
    const [client, ...more] = Object.values(exported ?? {}).filter(isClient)
    if (client === undefined || more.length > 0) throw new Error("umwelt/model.ts must export exactly one Client")
    const model = client[modelKey]
    const migration = nextMigration(model, name, new Date())
    if (migration === undefined) return "no change: the chain already folds to the Model"
    if (model.migrations.some(({ id }) => id === migration.id)) throw new Error(`${migration.id} exists already`)
    writeFileSync(join(migrations, `${migration.id}.ts`), migrationFile(migration))
    writeFileSync(index, indexFile([...model.migrations.map(({ id }) => id), migration.id]))
    return `wrote umwelt/migrations/${migration.id}.ts`
}

const [, , command, name, ...rest] = process.argv
try {
    if (command !== "create" || name === undefined || rest.length > 0 || !isMigrationName(name))
        throw new Error("usage: umwelt create <name>   (name: letters, digits, _ and -)")
    console.log(await create(name))
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
}
