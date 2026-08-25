/**
 * INS.HEAD / INS.TAIL have no line anchors, so remapEditsToCurrent pushes
 * nothing onto `offsets` and returns null whenever those are the only ops.
 *
 * WHY THIS SUITE EXISTS. Recovery's fail-closed rule is "every remapped
 * anchor shares one offset". BOF/EOF inserts never call `mapAnchor`, so the
 * offset list is empty, and `if (offsets.length === 0) return null` fires
 * even when the drift is a suffix append that cannot affect `INS.HEAD`, or a
 * prefix insert that cannot affect `INS.TAIL`.
 *
 * The model then gets a mismatch instead of a recovered apply, and retries
 * against a new tag. That is the wrong answer for an insert that is defined
 * relative to the file edges, not to a numbered line.
 *
 * THE CONTRACT THIS PINS. After unrelated drift, `tryRecover` MUST replay
 * a pure `INS.HEAD` / `INS.TAIL` onto the live text. If this file is red,
 * the empty-offset short-circuit is still in `remapEditsToCurrent`. Do not
 * `it.failing` it.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("INS.HEAD recovers across a suffix append", () => {
	it("replays the head insert onto the drifted file", () => {
		const store = new InMemorySnapshotStore();
		const original = "keep-a\nkeep-b";
		const drifted = "keep-a\nkeep-b\nappended";
		const tag = store.record("f.ts", original);
		const recovered = new Recovery(store).tryRecover({
			path: "f.ts",
			currentText: drifted,
			fileHash: tag,
			edits: parsePatch("INS.HEAD:\n+new-head").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered?.text.split("\n")).toEqual(["new-head", "keep-a", "keep-b", "appended"]);
	});
});

describe("INS.TAIL recovers across a prefix insert", () => {
	it("replays the tail insert onto the drifted file", () => {
		const store = new InMemorySnapshotStore();
		const original = "keep-a\nkeep-b";
		const drifted = "prefixed\nkeep-a\nkeep-b";
		const tag = store.record("f.ts", original);
		const recovered = new Recovery(store).tryRecover({
			path: "f.ts",
			currentText: drifted,
			fileHash: tag,
			edits: parsePatch("INS.TAIL:\n+new-tail").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered?.text.split("\n")).toEqual(["prefixed", "keep-a", "keep-b", "new-tail"]);
	});
});

describe("INS.HEAD still recovers when the live file is byte-identical", () => {
	it("offset-zero edge insert is a recovery, not a mismatch", () => {
		const store = new InMemorySnapshotStore();
		const original = "body";
		const tag = store.record("f.ts", original);
		const recovered = new Recovery(store).tryRecover({
			path: "f.ts",
			currentText: original,
			fileHash: tag,
			edits: parsePatch("INS.HEAD:\n+h").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered?.text.split("\n")).toEqual(["h", "body"]);
	});
});
