// Calls the context source makes. Siblings sort by front matter `order`, then by name.

/** @type {import("holon-md").Config} */
export default ({ node }) => ({
  // One row per child with `read_when`: its document and when to read it.
  table: () => {
    const rows = [...node.children]
      .filter((child) => child.meta.read_when)
      .sort((a, b) => (a.meta.order ?? Infinity) - (b.meta.order ?? Infinity));
    return [
      "| Document | Read when |",
      "| :-- | :-- |",
      ...rows.map((child) => `| [${child.title}](${child.path}) | ${child.meta.read_when} |`),
    ].join("\n");
  },
});
