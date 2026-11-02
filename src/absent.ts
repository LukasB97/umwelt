/**
 * Marks a field absent in input: in Write `data` it removes an optional field, in `mustMatch` and `where` it names a
 * field that is missing. A symbol, so it is never JSON: it cannot come from stored content or from a request body.
 * Registered, so two installed copies of Umwelt share it.
 */
export const absent: unique symbol = Symbol.for("@lukas.b97/umwelt/absent")
export type Absent = typeof absent
