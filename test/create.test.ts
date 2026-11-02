import { describe, expect, it } from "@effect/vitest"
import { execFile } from "node:child_process"
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll } from "vitest"
import { changeOf } from "../src/chain/check.ts"
import { isClient, modelKey } from "../src/chain/create.ts"
import { migrationHash } from "../src/migration.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const cli = join(root, "src", "chain", "cli.ts")

/** Host project: `effect` links to this repository's copy, `umwelt-ts` forwards to this repository's source. */
const project = mkdtempSync(join(tmpdir(), "umwelt-create-"))
const core = join(project, "node_modules", "umwelt-ts")
mkdirSync(core, { recursive: true })
writeFileSync(join(core, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }))
writeFileSync(
    join(core, "index.js"),
    `export * from ${JSON.stringify(pathToFileURL(join(root, "src", "index.ts")).href)}\n`
)
symlinkSync(realpathSync(join(root, "node_modules", "effect")), join(project, "node_modules", "effect"), "junction")
mkdirSync(join(project, "umwelt"))
afterAll(() => rmSync(project, { recursive: true, force: true }))

const migrations = join(project, "umwelt", "migrations")

const model = (fields: string) =>
    writeFileSync(
        join(project, "umwelt", "model.ts"),
        [
            'import { Schema } from "effect"',
            'import { Umwelt } from "umwelt-ts"',
            'import migrations from "./migrations/index.ts"',
            "",
            `export const Track = Umwelt.type("Track", { slug: Schema.String, ${fields} }, { uniqueKey: Schema.Struct({ slug: Schema.String }) })`,
            "export const umwelt = Umwelt.make([Track], { migrations })",
            ""
        ].join("\n")
    )

const create = async (name: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "create", name], { cwd: project })
    return stdout.trim()
}

/** Id of the file a run wrote, from its output. */
const written = (output: string) => /([\w-]+)\.ts$/u.exec(output)?.[1] ?? ""

const file = (id: string) => readFileSync(join(migrations, `${id}.ts`), "utf8")

describe("umwelt create", () => {
    it("writes the chain as the Model changes, and nothing when it does not", async () => {
        model("title: Schema.String")
        const initial = written(await create("initial"))
        expect(initial).toMatch(/^\d{8}-\d{4}-initial$/u)
        expect(file(initial)).toContain("parent: null,")
        expect(file(initial)).toContain("Track: Umwelt.step({ // safe\n            before: null,")
        expect(file(initial)).not.toContain("migrate:")

        expect(await create("again")).toBe("no change: the chain already folds to the Model")
        model('title: Schema.String.annotate({ description: "Title of the track" })')
        expect(await create("documented")).toBe("no change: the chain already folds to the Model")

        model("title: Schema.String, seconds: Schema.Finite")
        const seconds = written(await create("seconds"))
        expect(file(seconds)).toContain(`parent: { id: "${initial}", hash: "sha256:`)
        expect(file(seconds)).toContain("Track: Umwelt.step({ // transforming")
        expect(file(seconds)).toContain("migrate: null")

        model("seconds: Schema.Finite")
        const lean = written(await create("lean"))
        expect(file(lean)).toContain("Track: Umwelt.step({ // destructive")
        expect(file(lean)).not.toContain("migrate:")

        expect(readdirSync(migrations).toSorted()).toEqual(
            [`${initial}.ts`, `${seconds}.ts`, `${lean}.ts`, "index.ts"].toSorted()
        )
        const index = readFileSync(join(migrations, "index.ts"), "utf8")
        const order = [initial, seconds, lean].map((id) => index.indexOf(`from "./${id}.ts"`))
        expect(order).toEqual(order.toSorted((left, right) => left - right))
        expect(order.every((position) => position > 0)).toBe(true)

        const loaded: unknown = await import(pathToFileURL(join(project, "umwelt", "model.ts")).href)
        const client = Object.values(loaded ?? {}).find(isClient)
        if (client === undefined) throw new Error("no Client")
        const chain = client[modelKey].migrations
        expect(chain.map(({ id }) => id)).toEqual([initial, seconds, lean])
        expect(chain[1]?.parent?.hash).toBe(chain[0] === undefined ? "" : migrationHash(chain[0]))
        expect(changeOf(client[modelKey], { ledger: [], objects: new Map() }).blocking).toEqual([
            { kind: "migrationMissing", migration: seconds, type: "Track" }
        ])
    })

    it("rejects a name that cannot be part of a file name", async () => {
        await expect(create("two words")).rejects.toThrow(/usage: umwelt create <name>/u)
    })
})
