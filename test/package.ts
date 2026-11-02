/**
 * Smoke test of the package as npm ships it: packs the tarball, installs it with `effect` into a fresh project outside
 * the repository, imports it under plain Node, typechecks a consumer file against the shipped declarations, and runs
 * `umwelt create`. Removes the project afterwards. Run by CI after the tests.
 */
import { execFileSync, execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")

/** A consumer's environment: without the `npm_*` variables the package manager running this script passes on. */
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/iu.test(name)))
/** npm and npx are shell scripts on Windows, so they run through the shell; no command holds outside input. */
const shell = (command: string, directory: string) =>
    execSync(command, { cwd: directory, env: environment, stdio: "inherit" })
const node = (parameters: readonly string[], directory: string) =>
    execFileSync(process.execPath, parameters, { cwd: directory, env: environment, stdio: "inherit" })

const files = {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    /** Plain JavaScript: Node loads the package without type stripping. */
    "main.js": [
        'import { Umwelt } from "@lukas.b97/umwelt"',
        'import effect from "effect/package.json" with { type: "json" }',
        "",
        'console.log(`plain node imports Umwelt (${Object.keys(Umwelt).join(", ")}) on effect ${effect.version}`)',
        ""
    ].join("\n"),
    "tsconfig.json": JSON.stringify({
        compilerOptions: {
            module: "nodenext",
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            types: []
        },
        files: ["consumer.ts"]
    }),
    /** Checked against the shipped declarations; the expected error proves the types are not `any`. */
    "consumer.ts": [
        'import { Schema } from "effect"',
        'import { Umwelt, type ObjectId } from "@lukas.b97/umwelt"',
        "",
        "const Track = Umwelt.type(",
        '    "Track",',
        "    { slug: Schema.String, note: Schema.optionalKey(Schema.String) },",
        "    { uniqueKey: Schema.Struct({ slug: Schema.String }) }",
        ")",
        'const Play = Umwelt.type("Play", { track: Umwelt.one("Track"), at: Schema.Date })',
        "export const umwelt = Umwelt.make([Track, Play], { migrations: [] })",
        "export const get = (id: ObjectId<typeof Play>) => umwelt.Play.get({ id })",
        'export const forget = umwelt.Track.write({ data: { slug: "night-drive", note: Umwelt.absent }, mustExist: true })',
        "// @ts-expect-error Track has no `history`",
        'umwelt.Track.history({ object: { slug: "night-drive" } })',
        ""
    ].join("\n"),
    "umwelt/model.ts": [
        'import { Schema } from "effect"',
        'import { Umwelt } from "@lukas.b97/umwelt"',
        'import migrations from "./migrations/index.ts"',
        "",
        'export const Note = Umwelt.type("Note", { text: Schema.String })',
        "export const umwelt = Umwelt.make([Note], { migrations })",
        ""
    ].join("\n")
}

const temporary = mkdtempSync(join(tmpdir(), "umwelt-package-"))
const project = join(temporary, "project")
try {
    shell(`npm pack --pack-destination "${temporary}"`, root)
    const [tarball, ...more] = readdirSync(temporary).filter((name) => name.endsWith(".tgz"))
    if (tarball === undefined || more.length > 0) throw new Error("npm pack must write exactly one tarball")

    mkdirSync(join(project, "umwelt"), { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
    shell(`npm install --no-audit --no-fund "../${tarball}" effect`, project)

    node(["main.js"], project)
    node([tsc, "-p", "."], project)
    console.log("consumer.ts typechecks against the shipped declarations")

    shell("npx --no umwelt create initial", project)
    const migrations = readdirSync(join(project, "umwelt", "migrations"))
    const written = migrations.find((name) => /^\d{8}-\d{4}-initial\.ts$/u.test(name))
    if (written === undefined) throw new Error(`umwelt create wrote no migration: ${migrations.join(", ")}`)
    console.log(`umwelt/migrations: ${migrations.join(", ")}`)
} finally {
    rmSync(temporary, { recursive: true, force: true })
}
