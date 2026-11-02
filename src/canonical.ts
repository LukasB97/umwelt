/** Canonical JSON: keys sorted recursively, no whitespace; equal structure gives equal text and equal hash. */
import { createHash } from "node:crypto"

const isPlainObject = (value: unknown): value is { readonly [key: string]: unknown } =>
    typeof value === "object" && value !== null && !Array.isArray(value)

const sorted = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(sorted)
        : isPlainObject(value)
          ? Object.fromEntries(
                Object.keys(value)
                    .toSorted()
                    .map((key) => [key, sorted(value[key])])
            )
          : value

/** JSON text of an encoded value with object keys sorted at every depth; `undefined` keys are absent. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sorted(value))

/** `sha256:<hex>` of the canonical JSON. */
export const sha256 = (value: unknown): string =>
    `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`

/** Equal as JSON: same structure, key order aside. */
export const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)
