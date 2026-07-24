/**
 * Locks the MV no-clobber contract: `MV a -> b` must NEVER silently destroy an
 * existing, different file `b`.
 *
 * Why this suite exists: `fs.move` overwrites its destination unconditionally
 * (temp + atomic rename), and the patcher's only prior move guard rejected a
 * self-move (dest === source). Nothing stopped `MV a -> b` when `b` already held
 * the user's real content: the move wrote a's (edited) bytes over b and deleted
 * a, so b was gone with no error, no warning, and no snapshot of the lost file.
 * A model naming a wrong or hallucinated destination could erase real work. That
 * is a destructive filesystem op that silently destroys user data, and this
 * suite fails if the guard regresses.
 *
 * The guard must also NOT over-reject: a rename that only respells one file (a
 * case-only rename on a case-insensitive volume, or a path through a symlink) is
 * not a clobber and must still work, which is why the guard tests identity
 * (isSameExistingFile), not path strings.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	NodeFilesystem,
	Patch,
	Patcher,
} from "@veyyon/hashline";

const SOURCE = "src/from.ts";
const DEST = "src/to.ts";
const SOURCE_CONTENT = "alpha\nbeta\ngamma\n";
const DEST_CONTENT = "PRECIOUS\nUSER\nWORK\n";

describe("Patcher MV refuses to clobber an existing destination", () => {
	it("throws and leaves BOTH files byte-for-byte intact when the destination already exists", async () => {
		// The core data-loss case. Before the guard this move overwrote to.ts with
		// from.ts's content and deleted from.ts, destroying the user's to.ts. The move
		// must be refused with a clear error, and crucially NEITHER file may change.
		const fs = new InMemoryFilesystem([
			[SOURCE, SOURCE_CONTENT],
			[DEST, DEST_CONTENT],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(SOURCE, SOURCE_CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`${formatHashlineHeader(SOURCE, tag)}\nMV ${DEST}`))).rejects.toThrow(
			/destination src\/to\.ts already exists; refusing to overwrite/,
		);

		// Both files survive with their exact original bytes — no partial move.
		expect(fs.get(SOURCE)).toBe(SOURCE_CONTENT);
		expect(fs.get(DEST)).toBe(DEST_CONTENT);
	});

	it("still moves normally when the destination does not exist (guard does not over-reject)", async () => {
		// The guard must fire ONLY on a real clobber. A move to a fresh path is the
		// common case and must keep working: source vacated, destination created with
		// the source's content.
		const fs = new InMemoryFilesystem([[SOURCE, SOURCE_CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(SOURCE, SOURCE_CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`${formatHashlineHeader(SOURCE, tag)}\nMV ${DEST}`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(SOURCE)).toBeUndefined();
		expect(fs.get(DEST)).toBe(SOURCE_CONTENT);
	});

	it("aborts the WHOLE batch before any write when one section's move would clobber", async () => {
		// prepare() runs for every section before any commit, so a clobbering move in
		// one section must abort the batch during prepare and leave a sibling section's
		// edit unwritten — the all-or-nothing guarantee. Here the OTHER section's file
		// must remain exactly its original content, proving no write leaked out.
		const OTHER = "src/other.ts";
		const OTHER_CONTENT = "keep\nme\n";
		const fs = new InMemoryFilesystem([
			[OTHER, OTHER_CONTENT],
			[SOURCE, SOURCE_CONTENT],
			[DEST, DEST_CONTENT],
		]);
		const snapshots = new InMemorySnapshotStore();
		const otherTag = snapshots.record(OTHER, OTHER_CONTENT);
		const sourceTag = snapshots.record(SOURCE, SOURCE_CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const patch = Patch.parse(
			`${formatHashlineHeader(OTHER, otherTag)}\nSWAP 1.=1:\n+kept\n` +
				`${formatHashlineHeader(SOURCE, sourceTag)}\nMV ${DEST}`,
		);

		await expect(patcher.apply(patch)).rejects.toThrow(/already exists; refusing to overwrite/);

		// The sibling edit never landed: all three files hold their original bytes.
		expect(fs.get(OTHER)).toBe(OTHER_CONTENT);
		expect(fs.get(SOURCE)).toBe(SOURCE_CONTENT);
		expect(fs.get(DEST)).toBe(DEST_CONTENT);
	});

	it("preflight (dry-run) also rejects a clobbering move without touching the filesystem", async () => {
		// The dry-run path shares prepare(), so it must surface the same refusal. A CI
		// check that green-lights a patch which would destroy a file is worse than
		// useless.
		const fs = new InMemoryFilesystem([
			[SOURCE, SOURCE_CONTENT],
			[DEST, DEST_CONTENT],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(SOURCE, SOURCE_CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.preflight(Patch.parse(`${formatHashlineHeader(SOURCE, tag)}\nMV ${DEST}`))).rejects.toThrow(
			/already exists; refusing to overwrite/,
		);
		expect(fs.get(SOURCE)).toBe(SOURCE_CONTENT);
		expect(fs.get(DEST)).toBe(DEST_CONTENT);
	});
});

describe("NodeFilesystem.isSameExistingFile underpins the guard's respell exception", () => {
	it("recognises a symlink alias as the SAME file, but two distinct files as different", async () => {
		// The guard allows a move whose destination is only a respelling of the source
		// (a symlink, or case-only on a case-insensitive volume) because that is a
		// rename, not a clobber. That exception rides entirely on isSameExistingFile
		// comparing device+inode, not path strings: a symlink to the source resolves to
		// the same inode (SAME → allowed), while an unrelated file does not (DIFFERENT →
		// refused). Assert both directions on real disk.
		const dir = await mkdtemp(join(tmpdir(), "hashline-mv-clobber-"));
		const real = join(dir, "real.ts");
		const link = join(dir, "link.ts");
		const other = join(dir, "other.ts");
		await writeFile(real, SOURCE_CONTENT);
		await writeFile(other, DEST_CONTENT);
		await symlink(real, link);

		const fs = new NodeFilesystem();
		expect(await fs.isSameExistingFile(real, link)).toBe(true);
		expect(await fs.isSameExistingFile(real, other)).toBe(false);
		// Sanity: the "other" file the guard would protect is untouched by the probe.
		expect(await readFile(other, "utf8")).toBe(DEST_CONTENT);
	});
});
