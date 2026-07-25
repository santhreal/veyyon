import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * TOOLE-4: a write that cannot complete must leave the original file EXACTLY as
 * it was, and must say so.
 *
 * This is the failure with the worst consequence in the whole tool surface. The
 * agent is usually rewriting a file it has already read, so the content it was
 * replacing is gone from disk the moment a naive write truncates. If a
 * permission or space failure landed halfway, the user would be left with a
 * truncated or empty source file and a tool result that read like success. There
 * is no recovering that from the transcript.
 *
 * The defense is `commitFileContentAtomic`: the bytes go to a sibling temp file
 * and a rename swaps them in, so a failure at any point before the rename leaves
 * the original untouched, and the rename itself is atomic. These tests prove the
 * property through the REAL `WriteTool`, not through the primitive, because the
 * tool is where the guarantee has to hold: it is the only writer the agent has.
 *
 * Every assertion is on the file's exact bytes. "The file still exists" and "it
 * is non-empty" would both pass on a file that lost half its content.
 *
 * On ENOSPC: a genuine out-of-space failure needs a loop-mounted filesystem and
 * therefore root, so it is not reproduced here. It reaches the same code by the
 * same route as the permission failures below (the temp write throws before any
 * rename), which is what the atomicity argument rests on. That limit is stated
 * rather than faked, because a mocked ENOSPC would prove only that the mock was
 * wired up.
 */
describe("a write that fails leaves the original file intact", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir = "";

	/** The content every test expects to survive a failed write, byte for byte. */
	const ORIGINAL = "export const answer = 42;\n// second line\n";
	const REPLACEMENT = "export const answer = 0;\n";

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-fail-"));
	});

	afterEach(async () => {
		// Permissions are dropped inside the tests; restore them or cleanup fails
		// and leaks an unwritable directory into the temp tree.
		await fs.chmod(tmpDir, 0o700).catch(() => {});
		for (const entry of await fs.readdir(tmpDir).catch(() => [])) {
			await fs.chmod(path.join(tmpDir, entry), 0o700).catch(() => {});
		}
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = "";
		}
	});

	function tool(): WriteTool {
		return new WriteTool(
			makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getSessionFile: () => path.join(tmpDir, "s.jsonl"),
				getSessionSpawns: () => "*",
				getArtifactsDir: () => path.join(tmpDir, "artifacts"),
				allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
				settings: Settings.isolated({ "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": false }),
				enableLsp: false,
				getPlanModeState: () => ({ enabled: false }),
			}),
		);
	}

	/** Seed a file with {@link ORIGINAL} and return its absolute path. */
	async function seed(name: string): Promise<string> {
		const file = path.join(tmpDir, name);
		await fs.writeFile(file, ORIGINAL);
		return file;
	}

	/** Run a write and capture the failure, so the same shape serves every test. */
	async function failingWrite(file: string): Promise<Error> {
		try {
			await tool().execute("w1", { path: file, content: REPLACEMENT });
		} catch (err) {
			return err as Error;
		}
		throw new Error(`expected the write to ${file} to fail, but it succeeded`);
	}

	describe("when the containing directory is not writable", () => {
		// The rename needs write permission on the DIRECTORY, not on the file, so
		// this is the case a file-permission check alone would miss entirely.

		it("leaves the original bytes untouched", async () => {
			const file = await seed("locked-dir.ts");
			await fs.chmod(tmpDir, 0o500);

			await failingWrite(file);

			await fs.chmod(tmpDir, 0o700);
			expect(await fs.readFile(file, "utf8")).toBe(ORIGINAL);
		});

		it("reports the failure instead of claiming success", async () => {
			// The silent-success shape is the dangerous one: the agent would move on
			// believing the edit landed and keep building on content that is not there.
			const file = await seed("locked-dir-report.ts");
			await fs.chmod(tmpDir, 0o500);

			const error = await failingWrite(file);

			await fs.chmod(tmpDir, 0o700);
			expect(error.message).toContain("EACCES");
			// The path must be in the message, and it must be the path the agent
			// ASKED for. The atomic write fails on its hidden temp sibling, so the raw
			// errno named `.locked-dir-report.ts.<pid>.<n>.tmp` — a file the caller
			// never heard of, which no longer exists by the time anyone reads the
			// error. That is not enough to retry, report, or ask the user to fix a
			// permission, so the failure is now re-thrown against the real target.
			expect(error.message).toContain(file);
			expect(error.message).not.toContain(".tmp");
		});

		it("keeps the underlying errno reachable as the cause", async () => {
			// The message is rewritten for a human; the machine-readable failure must
			// survive it. Losing `code` would break any caller that distinguishes
			// EACCES from ENOSPC, and would make the rewrite a downgrade.
			const file = await seed("locked-dir-cause.ts");
			await fs.chmod(tmpDir, 0o500);

			const error = await failingWrite(file);

			await fs.chmod(tmpDir, 0o700);
			expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
		});

		it("explains that the write is staged through a temporary file", async () => {
			// Without this clause the message reads as "permission denied on a file
			// you can plainly write", because the denial is on the DIRECTORY. Saying
			// where the failure happened is what makes the fix obvious.
			const file = await seed("locked-dir-explain.ts");
			await fs.chmod(tmpDir, 0o500);

			const error = await failingWrite(file);

			await fs.chmod(tmpDir, 0o700);
			expect(error.message).toContain("temporary file");
		});

		it("leaves no temp file behind once the directory is writable again", async () => {
			// The atomic write's temp sibling must not accumulate. Debris here is both
			// clutter and a source of confusing half-content files next to real ones.
			const file = await seed("locked-dir-debris.ts");
			await fs.chmod(tmpDir, 0o500);
			await failingWrite(file);

			await fs.chmod(tmpDir, 0o700);
			const leftovers = (await fs.readdir(tmpDir)).filter(name => name !== path.basename(file));
			expect(leftovers).toEqual([]);
		});
	});

	describe("when the target file itself is read-only", () => {
		// A read-only file in a writable directory is the common case: a checked-in
		// generated file, a `chmod -w` guard, a file owned by another user.

		it("either replaces the file or leaves it exactly as it was, never in between", async () => {
			// POSIX rename does not consult the target's mode, so this write may well
			// succeed. What must never happen is a partial result, which is what the
			// assertion pins: one of two exact byte strings, nothing else.
			const file = await seed("readonly.ts");
			await fs.chmod(file, 0o400);

			try {
				await tool().execute("w1", { path: file, content: REPLACEMENT });
			} catch {
				// Either outcome is acceptable; the file's contents are the contract.
			}

			const after = await fs.readFile(file, "utf8");
			expect([ORIGINAL, REPLACEMENT]).toContain(after);
		});

		it("keeps the file's mode when the write does land", async () => {
			// The rename swaps in a fresh inode, so a naive implementation would give
			// the replacement the temp file's private 0o600 and silently strip a
			// script's +x or a file's group-read bit.
			const file = await seed("mode-preserved.ts");
			await fs.chmod(file, 0o755);

			await tool().execute("w1", { path: file, content: REPLACEMENT });

			expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
			expect(await fs.readFile(file, "utf8")).toBe(REPLACEMENT);
		});
	});

	describe("when the path cannot be a file at all", () => {
		it("a write to an existing DIRECTORY fails and does not remove it", async () => {
			// A model that passes a directory path must get an error, not a destroyed
			// directory. The rename would have to clobber the directory to "succeed".
			const dir = path.join(tmpDir, "a-directory");
			await fs.mkdir(dir);
			await fs.writeFile(path.join(dir, "inside.txt"), "still here\n");

			await failingWrite(dir);

			expect((await fs.stat(dir)).isDirectory()).toBe(true);
			expect(await fs.readFile(path.join(dir, "inside.txt"), "utf8")).toBe("still here\n");
		});

		it("a write under a missing parent creates the parent rather than failing", async () => {
			// The counterpart control. Not every failure-shaped path is a failure: a
			// new nested file is ordinary, and must not be turned into an error by a
			// too-eager guard added for the cases above.
			const file = path.join(tmpDir, "new", "nested", "file.ts");

			await tool().execute("w1", { path: file, content: REPLACEMENT });

			expect(await fs.readFile(file, "utf8")).toBe(REPLACEMENT);
		});
	});

	describe("the control", () => {
		it("an ordinary write over an existing file replaces it exactly", async () => {
			// Without this, every assertion above is satisfied by a write tool that
			// never writes anything.
			const file = await seed("ordinary.ts");

			await tool().execute("w1", { path: file, content: REPLACEMENT });

			expect(await fs.readFile(file, "utf8")).toBe(REPLACEMENT);
		});
	});
});
