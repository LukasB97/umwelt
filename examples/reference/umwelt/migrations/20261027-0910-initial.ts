/** Written by `umwelt create`: forms stay as written. */
import { Umwelt } from "@lukas.b97/umwelt"

export default Umwelt.migration({
    id: "20261027-0910-initial",
    parent: null,
    types: {
        Track: Umwelt.step({
            // safe
            before: null,
            after: {
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
            }
        }),
        Play: Umwelt.step({
            // safe
            before: null,
            after: {
                type: "object",
                properties: {
                    track: {
                        type: "object",
                        properties: { slug: { type: "string" } },
                        required: ["slug"],
                        additionalProperties: true,
                        "x-umwelt-relation": { target: "Track", card: "one", mode: "strict" }
                    },
                    at: { type: "string" }
                },
                required: ["at", "track"],
                additionalProperties: true
            }
        }),
        Playlist: Umwelt.step({
            // safe
            before: null,
            after: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    tracks: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: { slug: { type: "string" } },
                            required: ["slug"],
                            additionalProperties: true,
                            "x-umwelt-relation": { target: "Track", card: "many", mode: "strict" }
                        }
                    }
                },
                required: ["name", "tracks"],
                additionalProperties: true,
                "x-umwelt-unique-key": ["name"],
                "x-umwelt-history": true
            }
        })
    }
})
