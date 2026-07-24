/**
 * Locks the REM stale-delete contract: `REM` must NEVER delete a file whose live
 * content no longer matches the tag the model read.
 *
 * Why this suite exists: deleting a whole file is irreversible, so REM must be
 * the STRICTEST op about the content tag. It was the most lenient. REM applies
 * empty edits through the recovery path, and empty edits carry no anchor, so the
 * "head/tail inserts are position-stable, a stale tag is non-fatal" branch
 * treated a drifted file as fine, returned a soft warning, and commit then
 * deleted it — destroying content the model never saw (an external edit between
 * read and delete, or a stale/fabricated tag). That is a destructive filesystem
 * op that silently discards user work, and this suite fails if it regresses.
 *
 * The guard must reject the drifted delete (forcing a re-read, exactly as an
 * anchored edit on a drifted file does) while still deleting normally when the
 * live content matches the tag.
 */

import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
} from "@veyyon/hashline";

const PATH = "src/doomed.ts";
const SEEN_CONTENT = "line one\nline two\nline three\n";
const DRIFTED_CONTENT = "line one\nline two\nline three\nline four ADDED SINCE READ\n";

/** Header whose tag names `content`, regardless of what the filesystem currently holds. */
function headerFor(path: string, content: string): string {
	return formatHashlineHeader(path, computeFileHash(content));
}

describe("Patcher REM refuses to delete a file that drifted from its tag", () => {
	it("throws a MismatchError and leaves the drifted file on disk with its current bytes", async () => {
		// The core data-loss case: the model read version A (tag names A) and asked to
		// delete, but the file is now version B. Deleting B would discard the added
		// line the model never saw. REM must reject and the file must survive intact.
		const fs = new InMemoryFilesystem([[PATH, DRIFTED_CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`${headerFor(PATH, SEEN_CONTENT)}\nREM`))).rejects.toThrow(MismatchError);

		// The file is untouched — the drifted content is still there, byte for byte.
		expect(fs.get(PATH)).toBe(DRIFTED_CONTENT);
	});

	it("still deletes normally when the live content matches the tag (guard does not over-reject)", async () => {
		// The guard must fire ONLY on drift. When the file on disk is exactly the
		// version the model tagged, REM is safe and must delete it.
		const fs = new InMemoryFilesystem([[PATH, SEEN_CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, SEEN_CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nREM`));

		expect(result.sections[0]?.op).toBe("delete");
		expect(fs.get(PATH)).toBeUndefined();
	});

	it("aborts the WHOLE batch before any write when a stale REM is present", async () => {
		// prepare() runs for every section before any commit, so a stale REM must abort
		// the batch during prepare and leave a sibling section's edit unwritten — the
		// all-or-nothing guarantee. The sibling file must keep its original bytes.
		const OTHER = "src/keep.ts";
		const OTHER_CONTENT = "safe\ncontent\n";
		const fs = new InMemoryFilesystem([
			[OTHER, OTHER_CONTENT],
			[PATH, DRIFTED_CONTENT],
		]);
		const snapshots = new InMemorySnapshotStore();
		const otherTag = snapshots.record(OTHER, OTHER_CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const patch = Patch.parse(
			`${formatHashlineHeader(OTHER, otherTag)}\nSWAP 1.=1:\n+edited\n${headerFor(PATH, SEEN_CONTENT)}\nREM`,
		);

		await expect(patcher.apply(patch)).rejects.toThrow(MismatchError);

		// Neither the sibling edit nor the delete landed: both files hold original bytes.
		expect(fs.get(OTHER)).toBe(OTHER_CONTENT);
		expect(fs.get(PATH)).toBe(DRIFTED_CONTENT);
	});

	it("dry-run preflight also rejects a stale REM without touching the filesystem", async () => {
		// preflight shares prepare(), so a CI/dry-run check must surface the same
		// refusal — green-lighting a patch that would delete drifted content is a
		// silent data-loss waiting to happen on the real apply.
		const fs = new InMemoryFilesystem([[PATH, DRIFTED_CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.preflight(Patch.parse(`${headerFor(PATH, SEEN_CONTENT)}\nREM`))).rejects.toThrow(
			MismatchError,
		);
		expect(fs.get(PATH)).toBe(DRIFTED_CONTENT);
	});
});
