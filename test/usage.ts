/**
 * Typechecks the usage blocks of the operation documents against the exported types: every `ts` block under a
 * `## Usage` heading in CONTEXT/client/*.md, after the example Model of CONTEXT/client.md. A `@ts-expect-error` line
 * that does not fire fails like any other error. Part of `pnpm check`.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const documents = join(root, "CONTEXT", "client")
const output = join(root, "node_modules", ".cache", "umwelt-usage")

const read = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n")

const blocks = (markdown: string) => [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gmu)].map(([, code]) => code ?? "")

/** Blocks inside `## Usage` sections, each running to the next `##` heading. */
const usage = (markdown: string) =>
    blocks(
        markdown
            .split(/^## /mu)
            .filter((section) => section.startsWith("Usage\n"))
            .join("\n")
    )

const [model] = blocks(read(join(root, "CONTEXT", "client.md")))
if (model === undefined) throw new Error("CONTEXT/client.md has no example Model")

const prelude = [
    'import { Effect, Schema } from "effect"',
    'import { Umwelt, type Migration, type ObjectId } from "@lukas.b97/umwelt"',
    "",
    "declare const migrations: readonly Migration[]",
    model
].join("\n")

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
for (const file of readdirSync(documents).filter((name) => name.endsWith(".md"))) {
    const code = usage(read(join(documents, file)))
    const target = join(output, file.replace(/\.md$/u, ".ts"))
    if (code.length > 0) writeFileSync(target, [`// CONTEXT/client/${file}`, prelude, ...code].join("\n"))
}
writeFileSync(
    join(output, "tsconfig.json"),
    JSON.stringify({ extends: join(root, "tsconfig.json"), include: ["*.ts"] })
)

const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
const { status } = spawnSync(process.execPath, [tsc, "-p", output], { stdio: "inherit" })
process.exitCode = status ?? 1
