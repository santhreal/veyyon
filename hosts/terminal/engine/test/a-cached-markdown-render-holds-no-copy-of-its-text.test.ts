/**
 * A cached markdown render holds no copy of the text it renders.
 *
 * THE DEFECT. The module-level render cache keyed each entry on one string spelling the text and
 * every layout input. That string is a new copy of the text, so the cache held every message it
 * served twice: 2.9 KiB of the 10.2 KiB of strings one 3,000-character turn of an interactive
 * session kept.
 *
 * THE CLASS. A string the shared cache allocates per entry in proportion to the text it caches,
 * whether the key spells the layout beside the text or is the text after render normalization, which
 * replaces every tab. Distinct texts, with and without tabs, are rendered through fresh instances
 * while the test holds each text and its rows; the string bytes the heap holds are read before and
 * after the cache is cleared, so the difference is what the cache alone held. It stays under half a
 * copy of the texts; the defect held one copy. Each figure is read from a macrotask of its own, so no
 * frame of the renders is on the stack the collector scans conservatively.
 *
 * WHAT IT DOES NOT CATCH. A copy shorter than half its text, and memory a heap snapshot does not
 * class as a string. The rows of an instance no longer alive stay in the cache by design.
 */

import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const TEXTS = 16;
const TEXT_CHARS = 8_000;
const WIDTH = 100;

/** Fields per node of an `Inspector` heap snapshot: id, size, class name index, flags. */
const NODE_FIELDS = 4;

/** The texts and rows under measurement, rooted here and nowhere on the stack. */
const held: Array<string | readonly string[]> = [];

function snapshotStringBytes(): number {
	// Builds the snapshot during a full collection, so only live strings are in it.
	const snapshot = Bun.generateHeapSnapshot();
	if (snapshot.type !== "Inspector") throw new Error(`heap snapshot type ${snapshot.type}, expected Inspector`);
	const stringClass = snapshot.nodeClassNames.indexOf("string");
	if (stringClass < 0) throw new Error("heap snapshot has no string class");
	let bytes = 0;
	for (let i = 0; i < snapshot.nodes.length; i += NODE_FIELDS) {
		if (snapshot.nodes[i + 2] === stringClass) bytes += snapshot.nodes[i + 1];
	}
	return bytes;
}

/** String bytes the heap holds, read from a macrotask of its own. */
function stringBytes(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	setImmediate(() => {
		try {
			resolve(snapshotStringBytes());
		} catch (err) {
			reject(err);
		}
	});
	return promise;
}

/** Paragraphs of prose that differ from every other text's from the first word. */
function prose(seed: number, gap: string): string {
	let text = "";
	for (let n = 0; text.length < TEXT_CHARS; n++) {
		text += `Text ${seed} sentence ${n} renders${gap}through the shared cache once.${n % 6 === 5 ? "\n\n" : " "}`;
	}
	return text;
}

describe("a cached markdown render holds no copy of its text", () => {
	it.each([
		["prose", " "],
		["prose with tabs", "\t"],
	])("%s: under half a copy of the texts it caches beyond their rows", async (_kind, gap) => {
		clearRenderCache();
		let chars = 0;
		for (let seed = 0; seed < TEXTS; seed++) {
			const text = prose(seed, gap);
			const rows = new Markdown(text, 0, 0, defaultMarkdownTheme).render(WIDTH);
			// A fresh instance is served the cached array, so the text has an entry.
			expect(new Markdown(text, 0, 0, defaultMarkdownTheme).render(WIDTH)).toBe(rows);
			held.push(text, rows);
			chars += text.length;
		}

		const cached = await stringBytes();
		clearRenderCache();
		const cleared = await stringBytes();
		held.length = 0;

		expect((cached - cleared) / chars).toBeLessThan(0.5);
	});
});
