/** `umwelt create`: the next Migration from the difference between chain and Model, and the files holding the chain. */
import { migrationHash, type Migration } from "../migration.ts"
import type { ResolvedModel } from "../resolve.ts"
import { changesOf } from "./chain.ts"
import { kindOf } from "./classify.ts"

/** Where a Client keeps the Model it was made from, for `umwelt create`; shared across copies of the library. */
export const modelKey: unique symbol = Symbol.for("umwelt-ts/model")

export const isClient = (value: unknown): value is { readonly [modelKey]: ResolvedModel } =>
    typeof value === "object" && value !== null && modelKey in value

/** Letters, digits, `_` and `-`: the name is part of a file name and an id. */
export const isMigrationName = (name: string) => /^[\w-]+$/u.test(name)

/** `YYYYMMDD-HHMM` in UTC, so ids read the same for everyone on the team. */
const stamp = (at: Date) => at.toISOString().replace(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+).*$/u, "$1$2$3-$4$5")

/** The Migration that makes the chain fold to the Model, or `undefined` when they already agree. `migrate: null` marks what Check waits for. */
export const nextMigration = (model: ResolvedModel, name: string, at: Date): Migration | undefined => {
    const changes = changesOf(model.types, model.migrations)
    if (changes.length === 0) return undefined
    const last = model.migrations.at(-1)
    return {
        id: `${stamp(at)}-${name}`,
        parent: last === undefined ? null : { id: last.id, hash: migrationHash(last) },
        types: Object.fromEntries(
            changes.map(({ type, before, after }) => {
                const step = { before, after }
                return [type, kindOf(step) === "transforming" ? { ...step, migrate: null } : step]
            })
        )
    }
}

const indent = 4
/** The repository's print width: short values stay on one line, as a formatter would leave them. */
const width = 120
const identifier = /^[A-Za-z_$][\w$]*$/u

const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name))

const entriesOf = (value: object): readonly (readonly [string | undefined, unknown])[] =>
    Array.isArray(value) ? value.map((item: unknown) => [undefined, item]) : Object.entries(value)

const entry = ([name, text]: readonly [string | undefined, string]) =>
    name === undefined ? text : `${key(name)}: ${text}`

const inline = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return JSON.stringify(value)
    const items = entriesOf(value).map(([name, item]) => entry([name, inline(item)]))
    if (Array.isArray(value)) return `[${items.join(", ")}]`
    return items.length === 0 ? "{}" : `{ ${items.join(", ")} }`
}

/** JSON as a TypeScript literal at the given nesting depth. */
const literal = (value: unknown, depth: number): string => {
    const flat = inline(value)
    if (typeof value !== "object" || value === null || indent * depth + flat.length <= width) return flat
    const pad = " ".repeat(indent * (depth + 1))
    const items = entriesOf(value).map(([name, item]) => pad + entry([name, literal(item, depth + 1)]))
    const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"]
    return [open, items.join(",\n"), `${" ".repeat(indent * depth)}${close}`].join("\n")
}

/** Steps sit three levels deep: `migration({ types: { T: step({` */
const stepDepth = 3

const stepText = ([type, step]: readonly [string, Migration["types"][string]]) =>
    [
        `        ${key(type)}: Umwelt.step({ // ${kindOf(step)}`,
        `            before: ${literal(step.before, stepDepth)},`,
        ...(step.migrate === null
            ? [
                  `            after: ${literal(step.after, stepDepth)},`,
                  "            // stored JSON of form before in, stored JSON fitting form after out; Identity stays",
                  "            migrate: null"
              ]
            : [`            after: ${literal(step.after, stepDepth)}`]),
        "        })"
    ].join("\n")

/** Text of a Migration file as `umwelt create` writes it. */
export const migrationFile = (migration: Migration) =>
    [
        "/** Written by `umwelt create`: forms stay as written. */",
        'import { Umwelt } from "umwelt-ts"',
        "",
        "export default Umwelt.migration({",
        `    id: ${JSON.stringify(migration.id)},`,
        migration.parent === null
            ? "    parent: null,"
            : `    parent: { id: ${JSON.stringify(migration.parent.id)}, hash: ${JSON.stringify(migration.parent.hash)} },`,
        "    types: {",
        Object.entries(migration.types).map(stepText).join(",\n"),
        "    }",
        "})",
        ""
    ].join("\n")

const binding = (id: string) => `m${id.replaceAll("-", "_")}`

/** Text of the chain's index file: every Migration file, oldest first. */
export const indexFile = (ids: readonly string[]) =>
    [
        "/** Maintained by `umwelt create`: the chain, oldest first. */",
        ...ids.map((id) => `import ${binding(id)} from "./${id}.ts"`),
        ...(ids.length === 0 ? [] : [""]),
        ids.length === 0
            ? "export default []"
            : `export default [\n${ids.map((id) => `    ${binding(id)}`).join(",\n")}\n]`,
        ""
    ].join("\n")
