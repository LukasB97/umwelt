---
order: 60
render_to: CONTEXT/engineering/postgres-jsonb/indexes.md
read_when: "Checking whether PostgreSQL JSONB indexes or operator classes define query meaning."
---
# Indexes
GIN indexes and operator classes can speed up JSONB queries.
They do not change query meaning.

Preserve semantics first. Index use is planning/performance concern after correctness.
