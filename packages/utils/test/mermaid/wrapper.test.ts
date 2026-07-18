import { describe, expect, it } from "bun:test";
import { extractMermaidBlocks, renderMermaidAscii, renderMermaidAsciiSafe } from "../../src/mermaid-ascii";

const GRAPH = "graph LR\n\tA --> B";

describe("renderMermaidAsciiSafe", () => {
	it("renders a valid graph identically to the throwing variant", () => {
		const safe = renderMermaidAsciiSafe(GRAPH);
		expect(safe).toBe(renderMermaidAscii(GRAPH));
		expect(safe).toContain("A");
		expect(safe).toContain("B");
	});

	it("returns null instead of throwing on unparseable source", () => {
		expect(() => renderMermaidAscii("not a diagram at all")).toThrow();
		expect(renderMermaidAsciiSafe("not a diagram at all")).toBeNull();
	});
});

describe("extractMermaidBlocks", () => {
	it("extracts every mermaid fence, trimmed, with a stable content hash", () => {
		const markdown = [
			"intro",
			"```mermaid",
			GRAPH,
			"```",
			"```ts",
			"const notMermaid = 1;",
			"```",
			"```mermaid",
			"graph TD\n\tX --> Y",
			"```",
		].join("\n");
		const blocks = extractMermaidBlocks(markdown);
		expect(blocks.map(b => b.source)).toEqual([GRAPH, "graph TD\n\tX --> Y"]);
		expect(blocks[0].hash).toBe(Bun.hash(GRAPH));
	});

	it("returns an empty list when no mermaid fences exist", () => {
		expect(extractMermaidBlocks("plain text\n```js\n1\n```")).toEqual([]);
	});
});
