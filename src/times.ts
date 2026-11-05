/**
 * Keys naming the times Umwelt sets on every Object, in `where` and `orderBy`. Symbols, so they never meet a payload
 * field: a Type may hold its own `changedAt`. Registered, so two installed copies of Umwelt share them.
 */
export const createdAt: unique symbol = Symbol.for("umwelt-ts/createdAt")
export const changedAt: unique symbol = Symbol.for("umwelt-ts/changedAt")
export type CreatedAt = typeof createdAt
export type ChangedAt = typeof changedAt

export type TimeColumn = "created" | "changed"

/** Column of `umwelt_object` a time key names; `undefined` for any other symbol. */
export const timeColumn = (key: symbol): TimeColumn | undefined =>
    key === createdAt ? "created" : key === changedAt ? "changed" : undefined
