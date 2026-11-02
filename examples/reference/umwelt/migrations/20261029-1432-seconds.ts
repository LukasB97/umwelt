/** Written by `umwelt create`: forms stay as written. */
import { Umwelt } from "@lukas.b97/umwelt"

export default Umwelt.migration({
    id: "20261029-1432-seconds",
    parent: {
        id: "20261027-0910-initial",
        hash: "sha256:ef9f14b82b67c812d200d1655e1832b3644f25fee703b5e606ff1f2a5e258345"
    },
    types: {
        Track: Umwelt.step({
            // transforming
            before: {
                type: "object",
                properties: {
                    slug: { type: "string" },
                    title: { type: "string" },
                    duration: { type: "number" },
                    note: { type: "string" }
                },
                required: ["duration", "slug", "title"],
                additionalProperties: true,
                "x-umwelt-unique-key": ["slug"]
            },
            after: {
                type: "object",
                properties: {
                    slug: { type: "string" },
                    title: { type: "string" },
                    seconds: { type: "number" },
                    note: { type: "string" }
                },
                required: ["seconds", "slug", "title"],
                additionalProperties: true,
                "x-umwelt-unique-key": ["slug"]
            },
            // stored JSON of form before in, stored JSON fitting form after out; Identity stays
            migrate: ({ duration, ...rest }) => ({ ...rest, seconds: duration })
        })
    }
})
