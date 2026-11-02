# Object

Object is one typed piece of content; every Object has [Type](type.md).

## Object ID

Object ID is primary key of Object: Umwelt assigns it on create, it never changes, it is never part of payload.
Every Object result carries it, like [Write](client/write.md), [Get](client/get.md), and [Query](client/query.md) results.
It goes back in as own parameter only: Get, [Delete](client/delete.md) by `ids`, [History](client/history.md), Write for Types without unique key, and Query `cursor`. Never inside `where`, `data`, or relation fields.
In code, Object ID is `ObjectId<T>`, opaque and branded per Type: Track's ID does not fit Play's parameter.
ID naming no Object of that Type, whether deleted, of another Type, or malformed, counts as unknown everywhere: Get gives `null`, Delete matches nothing, History gives empty list, Write rejects with `ConditionRejected`.

### Host References

Host tables keep Object IDs in own columns and read them back through Type's `ObjectId` schema, stored string to `ObjectId<T>`; decoding makes no Object.
Their foreign keys point at Umwelt's Object table, the one deliberate exception to developers never seeing Umwelt's tables: `Umwelt.objectTable` names table and columns, and that contract never changes.
Delete sees such references only through immediate, non-cascading constraints and reports them as `ReferencedByHost`; deferred constraints fail at host's commit, cascading ones change host rows without Umwelt's knowledge.

## Identity

Identity is subset of payload named by Type unique key, not separate field: Track with unique key `slug` has Identity `{ slug: "night-drive" }`.
Same Identity addresses same Object; different Identity addresses different Object.
Sameness compares values exactly: field boundaries, JSON null, absent fields, and value types stay distinct; JSON object key order never counts. JSON null is Identity value only when schema allows it.
Write addresses Object by Identity, or by Object ID where there is none; relations hold target Identity.
Identity never changes for one Object.
Type without unique key has no Identity: its Objects are found by `where` and addressed by Object ID only, like documents in a collection.

## Payload

Payload is one Object's current content and follows Type schema; nothing else is in it.
Umwelt sets `createdAt` on create and `changedAt` on every Write that changes content; both sit beside payload in results, and Deploy keeps them. Times are transaction time, so Writes in one host transaction share it.
