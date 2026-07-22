import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

/**
 * Recovery path isolation across many path names in one store.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("Recovery path isolation matrix", () => {
	it("tag for path i never recovers path j", () => {
		const store = new InMemorySnapshotStore();
		const paths = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
		const tags: string[] = [];
		for (let i = 0; i < paths.length; i++) {
			const body = text([`body-${i}`]);
			tags.push(store.record(paths[i]!, body));
		}
		for (let i = 0; i < paths.length; i++) {
			for (let j = 0; j < paths.length; j++) {
				if (i === j) continue;
				const recovered = new Recovery(store).tryRecover({
					path: paths[j]!,
					currentText: text([`body-${j}`]),
					fileHash: tags[i]!,
					edits: parsePatch("SWAP 1.=1:\n+hijack").edits,
				});
				// Wrong path tag must not succeed (same content might collide on hash only if bodies match).
				if (text([`body-${i}`]) !== text([`body-${j}`])) {
					expect(recovered).toBeNull();
				}
			}
		}
	});
});
