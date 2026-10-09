/**
 * WHY: every local-cli trial's scratch, which holds its workspace and a copy of the model provider's
 * sign-in, sat under one fixed `/tmp/vey` made with the default mode. Another user on the host could
 * list and read it, a second user's trials failed to write into the first user's root, and a user who
 * made `/tmp/vey` first, or planted a symbolic link there, decided where every credential copy landed.
 *
 * The cases check the root is named per user and still short enough for Chrome's socket, that a root
 * named by `VEYYON_EVAL_SCRATCH_ROOT` replaces it and fails when relative or too long for the socket,
 * that it is made readable by its user alone, that a looser one is tightened, and that a symbolic link
 * in its place is refused.
 *
 * Not caught: a root another user owns, which a test cannot make without privilege.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { localTrialLayout, requireScratchRoot, trialScratchRoot } from "../../../backends/local-cli/main";

const posix = process.platform !== "win32";

/** Run `body` with `VEYYON_EVAL_SCRATCH_ROOT` set to `value`, or unset for `undefined`, and restore it. */
function withScratchRoot<T>(value: string | undefined, body: () => T): T {
	const saved = process.env.VEYYON_EVAL_SCRATCH_ROOT;
	if (value === undefined) delete process.env.VEYYON_EVAL_SCRATCH_ROOT;
	else process.env.VEYYON_EVAL_SCRATCH_ROOT = value;
	try {
		return body();
	} finally {
		if (saved === undefined) delete process.env.VEYYON_EVAL_SCRATCH_ROOT;
		else process.env.VEYYON_EVAL_SCRATCH_ROOT = saved;
	}
}

describe("the scratch root of local trials", () => {
	it.skipIf(!posix)("is named for the user running them", () => {
		expect(withScratchRoot(undefined, trialScratchRoot)).toBe(`/tmp/vey-${process.getuid?.()}`);
	});

	it.skipIf(!posix)(
		"is the absolute directory VEYYON_EVAL_SCRATCH_ROOT names, and every trial's scratch is under it",
		() => {
			withScratchRoot("/srv/evals/../scratch", () => {
				expect(trialScratchRoot()).toBe("/srv/scratch");
				const layout = localTrialLayout("/runs", "run", { variant: "v", suite: "s", task: "t", repeat: 1 });
				expect(path.dirname(layout.scratch)).toBe("/srv/scratch");
			});
		},
	);

	it.skipIf(!posix)("fails for a relative VEYYON_EVAL_SCRATCH_ROOT", () => {
		expect(() => withScratchRoot("scratch", trialScratchRoot)).toThrow("is not an absolute path");
	});

	it.skipIf(!posix)(
		"takes a VEYYON_EVAL_SCRATCH_ROOT whose Chrome socket fits 107 bytes, and fails one byte longer",
		() => {
			const accepted = (root: string): boolean => {
				try {
					withScratchRoot(root, trialScratchRoot);
					return true;
				} catch (error) {
					expect(String(error)).toContain("Chrome's socket under it needs a root of at most");
					return false;
				}
			};
			let longest = "/s";
			while (accepted(`${longest}x`)) longest += "x";
			const layout = withScratchRoot(longest, () =>
				localTrialLayout("/runs", "run", { variant: "v", suite: "s", task: "t", repeat: 1 }),
			);
			expect(Buffer.byteLength(path.join(layout.tmp, "com.google.Chrome.XXXXXX", "SingletonSocket"))).toBe(107);
		},
	);

	it.skipIf(!posix)("keeps Chrome's socket under 107 bytes for the longest user id", () => {
		const layout = withScratchRoot(undefined, () =>
			localTrialLayout("/runs", "run", { variant: "v", suite: "s", task: "t", repeat: 1 }),
		);
		const longest = layout.tmp.replace(withScratchRoot(undefined, trialScratchRoot), "/tmp/vey-4294967294");
		expect(Buffer.byteLength(path.join(longest, "com.google.Chrome.XXXXXX", "SingletonSocket"))).toBeLessThanOrEqual(
			107,
		);
	});

	it.skipIf(!posix)("is made readable by its user alone, and a looser one is tightened", async () => {
		await using dir = await TempDir.create("@evals-scratch-root-");
		const made = dir.join("made");
		const loose = dir.join("loose");
		await fs.mkdir(loose, { mode: 0o755 });
		await fs.chmod(loose, 0o755);

		await requireScratchRoot(made);
		await requireScratchRoot(loose);

		expect((await fs.stat(made)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(loose)).mode & 0o777).toBe(0o700);
	});

	it.skipIf(!posix)("is refused when a symbolic link stands in its place", async () => {
		await using dir = await TempDir.create("@evals-scratch-root-link-");
		const elsewhere = dir.join("elsewhere");
		await fs.mkdir(elsewhere, { mode: 0o700 });
		const root = dir.join("root");
		await fs.symlink(elsewhere, root);

		await expect(requireScratchRoot(root)).rejects.toThrow("is not a directory but a link or a file");
	});
});
