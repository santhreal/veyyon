import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Two independent snapshot stores do not share tags.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("InMemorySnapshotStore isolation", () => {
	it("tag from store A is unknown in store B", () => {
		const a = new InMemorySnapshotStore();
		const b = new InMemorySnapshotStore();
		const body = text(["x"]);
		const tag = a.record("f.ts", body);
		const recovered = new Recovery(b).tryRecover({
			path: "f.ts",
			currentText: body,
			fileHash: tag,
			edits: parsePatch("SWAP 1.=1:\n+y").edits,
		});
		expect(recovered).toBeNull();
	});

	it("same content in both stores yields same tag value", () => {
		const a = new InMemorySnapshotStore();
		const b = new InMemorySnapshotStore();
		const body = text(["shared"]);
		expect(a.record("f.ts", body)).toBe(b.record("f.ts", body));
	});
});
