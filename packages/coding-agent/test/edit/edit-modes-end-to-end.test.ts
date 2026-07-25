/**
 * Every edit MODE actually edits a real file, and the bytes afterwards are the
 * bytes intended.
 *
 * WHY THIS SUITE EXISTS (TOOLE-5). The edit tool ships four interchangeable
 * modes, and the choice between them is configuration (`edit.mode`, or the
 * `VEYYON_EDIT_VARIANT` override), so any of the four can be the one a real user
 * runs on. Coverage was uneven: the surrounding suites test the shared machinery
 * (the block resolver, fuzzy matching, diff normalization, the snapshot store)
 * and hashline's REFUSAL path, but no suite drove each mode end to end and then
 * looked at the file. Machinery tests passing while a mode's own wiring is broken
 * is exactly the shape of failure that ships.
 *
 * So every assertion here reads the file back and compares EXACT content. Not
 * "the call succeeded", not "no error was thrown", not a details field: the file.
 * A mode that reports success and writes nothing passes every weaker check.
 *
 * The four modes are one concern (apply an edit to a file) reached four ways, so
 * they live in one suite with a describe per mode. Each mode gets the same
 * questions asked of it:
 *
 *   - the update lands, byte for byte, and does not disturb the rest of the file,
 *   - creating a file works where the mode supports it,
 *   - a second, independent edit in the same call both land,
 *   - and a bad anchor is REFUSED with the file left untouched.
 *
 * That last one belongs here rather than in a refusals suite: a mode whose write
 * path works but whose failure path corrupts the file is worse than one that
 * cannot write at all, and the two paths share the code that decides where to
 * write.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { EditTool } from "@veyyon/coding-agent/edit";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/** The file every mode starts from. Trailing newline included deliberately: a
 * mode that drops it changes the file in a way diffs love to hide. */
const ORIGINAL = ["def greet(name):", '    print("Hi")', "", "def farewell(name):", '    print("Bye")', ""].join("\n");

let settingsState: SettingsTestState | undefined;
let tmpDir = "";

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-modes-e2e-"));
});

afterEach(async () => {
	if (tmpDir) {
		await removeWithRetries(tmpDir);
		tmpDir = "";
	}
});

/** A tool session pinned to one edit mode, with LSP formatting off so the bytes
 * on disk are the bytes the mode wrote and not a formatter's opinion. */
function editTool(mode: "replace" | "patch" | "apply_patch" | "hashline"): EditTool {
	return new EditTool(
		makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
				"edit.mode": mode,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		}) as never,
	);
}

/**
 * Read `file` through the REAL read tool and return the `[path#TAG]` header line
 * hashline requires.
 *
 * The tag certifies the snapshot the line numbers came from, and it is minted
 * fresh by every read and every applied edit. Hard-coding one would test nothing
 * and would rot the first time the hashing changed, so every hashline test below
 * anchors on a genuine read exactly as the agent must.
 */
async function hashlineHeader(file: string): Promise<string> {
	const result = await new ReadTool(
		makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "read.summarize.enabled": false, "edit.mode": "hashline" }),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		}) as never,
	).execute("read-for-tag", { path: file });
	for (const block of (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content ?? []) {
		if (block.type === "text" && block.text) {
			const header = block.text.split("\n", 1)[0];
			if (/^\[.+#[0-9A-Fa-f]{4}\]$/.test(header)) return header;
		}
	}
	throw new Error("read did not return a hashline header");
}

/** Seed a file with {@link ORIGINAL} and return its absolute path. */
async function seed(name = "app.py"): Promise<string> {
	const file = path.join(tmpDir, name);
	await fs.writeFile(file, ORIGINAL);
	return file;
}

const read = (file: string) => fs.readFile(file, "utf8");

/** ORIGINAL with the first print swapped, which is what most tests below expect. */
const GREETED = ORIGINAL.replace('    print("Hi")', '    print("Hello")');

describe("replace mode", () => {
	/** The core claim: exact old text becomes exact new text and nothing else
	 * moves. Compared against the whole file, so an edit that also mangled the
	 * second function would fail here rather than pass a substring check. */
	it("applies an update and leaves the rest of the file byte-identical", async () => {
		const file = await seed();
		await editTool("replace").execute("r1", {
			path: file,
			edits: [{ old_text: '    print("Hi")', new_text: '    print("Hello")' }],
		});
		expect(await read(file)).toBe(GREETED);
	});

	/** Two independent edits in one call must BOTH land. A mode that applied only
	 * the first would still look successful to the caller. */
	it("applies two independent edits in a single call", async () => {
		const file = await seed();
		await editTool("replace").execute("r2", {
			path: file,
			edits: [
				{ old_text: '    print("Hi")', new_text: '    print("Hello")' },
				{ old_text: '    print("Bye")', new_text: '    print("Goodbye")' },
			],
		});
		expect(await read(file)).toBe(
			ORIGINAL.replace('    print("Hi")', '    print("Hello")').replace('    print("Bye")', '    print("Goodbye")'),
		);
	});

	/** The failure path. A refused edit must leave the file exactly as it was;
	 * a partial application here would be silent corruption. */
	it("refuses an anchor that is not in the file and changes nothing", async () => {
		const file = await seed();
		await expect(
			editTool("replace").execute("r3", {
				path: file,
				edits: [{ old_text: 'print("NOT PRESENT")', new_text: "x" }],
			}),
		).rejects.toThrow();
		expect(await read(file)).toBe(ORIGINAL);
	});

	/** An ambiguous anchor is refused too, because picking one occurrence would
	 * be a guess, and a wrong guess is invisible in the result. */
	it("refuses an ambiguous anchor and changes nothing", async () => {
		const file = path.join(tmpDir, "dup.py");
		await fs.writeFile(file, 'print("x")\nprint("x")\n');
		await expect(
			editTool("replace").execute("r4", {
				path: file,
				edits: [{ old_text: 'print("x")', new_text: 'print("y")' }],
			}),
		).rejects.toThrow();
		expect(await read(file)).toBe('print("x")\nprint("x")\n');
	});
});

describe("patch mode", () => {
	/** The same update expressed as a unified-diff hunk. Asserting the whole file
	 * catches a hunk applied at the wrong offset, which is the classic patch bug
	 * and one that a "did it contain the new line" check would miss. */
	it("applies an update hunk and leaves the rest byte-identical", async () => {
		const file = await seed();
		await editTool("patch").execute("p1", {
			path: file,
			edits: [{ op: "update", diff: '@@ def greet(name):\n-    print("Hi")\n+    print("Hello")\n' }],
		});
		expect(await read(file)).toBe(GREETED);
	});

	/** Creation is a distinct operation with its own path handling, and the
	 * created file must hold exactly the given content. */
	it("creates a new file with exactly the given content", async () => {
		const file = path.join(tmpDir, "created.txt");
		await editTool("patch").execute("p2", {
			path: file,
			edits: [{ op: "create", diff: "line one\nline two\n" }],
		});
		expect(await read(file)).toBe("line one\nline two\n");
	});

	/** A hunk whose context does not exist must be refused with the file intact. */
	it("refuses a hunk whose context is absent and changes nothing", async () => {
		const file = await seed();
		await expect(
			editTool("patch").execute("p3", {
				path: file,
				edits: [{ op: "update", diff: "@@ nope\n-does not exist\n+replacement\n" }],
			}),
		).rejects.toThrow();
		expect(await read(file)).toBe(ORIGINAL);
	});

	/**
	 * `delete` removes the file outright, and it is the one operation with no
	 * undo in the tree. Checked for absence rather than for a success result,
	 * because a delete that reported success and left the file behind would leave
	 * the agent believing a migration completed when it did not.
	 */
	it("deletes the named file and leaves its neighbour alone", async () => {
		const file = await seed();
		const neighbour = path.join(tmpDir, "keep.py");
		await fs.writeFile(neighbour, 'print("keep")\n');

		await editTool("patch").execute("p4", { path: file, edits: [{ op: "delete" }] });

		expect(await fs.exists(file)).toBe(false);
		expect(await read(neighbour)).toBe('print("keep")\n');
	});

	/** The hunk a rename carries. `update` requires a diff even when the point of
	 * the call is the move, so the two always travel together in this mode. */
	const RENAME_HUNK = '@@ def greet(name):\n-    print("Hi")\n+    print("Hello")\n';

	/**
	 * A rename must MOVE the content, not copy it: the destination holds the
	 * edited bytes and the source is gone. A half-done rename that leaves both
	 * paths populated duplicates a module, and the duplicate then drifts.
	 *
	 * The destination is compared against the EDITED content rather than the
	 * original, because move-and-edit is one step here and a mode that moved the
	 * file but dropped the hunk would still satisfy a check for the old bytes.
	 */
	it("renames a file, carrying the edited bytes and leaving nothing behind", async () => {
		const file = await seed();

		await editTool("patch").execute("p5", {
			path: file,
			edits: [{ op: "update", rename: path.join(tmpDir, "renamed.py"), diff: RENAME_HUNK }],
		});

		expect(await fs.exists(file)).toBe(false);
		expect(await read(path.join(tmpDir, "renamed.py"))).toBe(GREETED);
	});

	/**
	 * The rename contract is strictly non-overwriting. Silently clobbering an
	 * existing destination is data loss the agent cannot see, so it must be a
	 * refusal, and BOTH files must survive it unchanged.
	 *
	 * The hunk is valid here on purpose: without it the call would be refused for
	 * a missing diff, and the test would pass while proving nothing about the
	 * destination check it is named for.
	 */
	it("refuses to rename onto an existing file, and both survive", async () => {
		const file = await seed();
		const occupied = path.join(tmpDir, "occupied.py");
		await fs.writeFile(occupied, 'print("occupied")\n');

		const error = await editTool("patch")
			.execute("p6", { path: file, edits: [{ op: "update", rename: occupied, diff: RENAME_HUNK }] })
			.then(
				() => undefined,
				(err: unknown) => err as Error,
			);

		expect(error?.message).toContain("already exists");
		expect(await read(file)).toBe(ORIGINAL);
		expect(await read(occupied)).toBe('print("occupied")\n');
	});
});

describe("apply_patch mode", () => {
	/** apply_patch takes ONE combined patch envelope naming its own files, so the
	 * path comes from inside the patch rather than from a parameter. That routing
	 * is the thing this mode adds, and it is what is checked here. */
	it("applies an update named inside the patch envelope", async () => {
		await seed();
		await editTool("apply_patch").execute("a1", {
			input: [
				"*** Begin Patch",
				"*** Update File: app.py",
				"@@ def greet(name):",
				'-    print("Hi")',
				'+    print("Hello")',
				"*** End Patch",
				"",
			].join("\n"),
		});
		expect(await read(path.join(tmpDir, "app.py"))).toBe(GREETED);
	});

	/** Add File is the create path through the envelope. */
	it("adds a file named inside the patch envelope", async () => {
		await editTool("apply_patch").execute("a2", {
			input: ["*** Begin Patch", "*** Add File: fresh.txt", "+hello world", "*** End Patch", ""].join("\n"),
		});
		expect(await read(path.join(tmpDir, "fresh.txt"))).toBe("hello world\n");
	});

	/**
	 * THE multi-file case, which is the whole reason this mode exists. Both files
	 * must change; a mode that applied only the first would leave the tree in a
	 * half-migrated state while reporting success.
	 */
	it("applies changes to two files from one envelope", async () => {
		await seed();
		await fs.writeFile(path.join(tmpDir, "other.py"), 'print("other")\n');
		await editTool("apply_patch").execute("a3", {
			input: [
				"*** Begin Patch",
				"*** Update File: app.py",
				"@@ def greet(name):",
				'-    print("Hi")',
				'+    print("Hello")',
				"*** Update File: other.py",
				"@@",
				'-print("other")',
				'+print("changed")',
				"*** End Patch",
				"",
			].join("\n"),
		});
		expect(await read(path.join(tmpDir, "app.py"))).toBe(GREETED);
		expect(await read(path.join(tmpDir, "other.py"))).toBe('print("changed")\n');
	});

	/** A refused envelope must leave EVERY file it named untouched, not just the
	 * one that failed. A per-file apply with no all-or-nothing story would leave
	 * the first file changed and the second not. */
	it("leaves both files untouched when the envelope cannot apply", async () => {
		await seed();
		await fs.writeFile(path.join(tmpDir, "other.py"), 'print("other")\n');
		await expect(
			editTool("apply_patch").execute("a4", {
				input: [
					"*** Begin Patch",
					"*** Update File: app.py",
					"@@ def greet(name):",
					"-absolutely not present",
					"+replacement",
					"*** End Patch",
					"",
				].join("\n"),
			}),
		).rejects.toThrow();
		expect(await read(path.join(tmpDir, "app.py"))).toBe(ORIGINAL);
		expect(await read(path.join(tmpDir, "other.py"))).toBe('print("other")\n');
	});

	/** `*** Delete File:` is the envelope's destructive operation, and it names its
	 * own target, so a routing bug here deletes the WRONG file. Both halves are
	 * asserted: the named file is gone and the unnamed one is not. */
	it("deletes the file named by `*** Delete File:` and only that file", async () => {
		await seed();
		await fs.writeFile(path.join(tmpDir, "other.py"), 'print("other")\n');

		await editTool("apply_patch").execute("a5", {
			input: ["*** Begin Patch", "*** Delete File: app.py", "*** End Patch", ""].join("\n"),
		});

		expect(await fs.exists(path.join(tmpDir, "app.py"))).toBe(false);
		expect(await read(path.join(tmpDir, "other.py"))).toBe('print("other")\n');
	});

	/**
	 * `*** Move to:` renames while applying the hunk, which is the one operation
	 * where a mode can lose an edit and a file in the same step. The destination
	 * must hold the EDITED content, not the original, and the source must be gone,
	 * so this asserts the moved-and-edited result rather than either half.
	 */
	it("moves a file and applies the hunk in the same envelope", async () => {
		await seed();

		await editTool("apply_patch").execute("a6", {
			input: [
				"*** Begin Patch",
				"*** Update File: app.py",
				"*** Move to: moved.py",
				"@@ def greet(name):",
				'-    print("Hi")',
				'+    print("Hello")',
				"*** End Patch",
				"",
			].join("\n"),
		});

		expect(await fs.exists(path.join(tmpDir, "app.py"))).toBe(false);
		expect(await read(path.join(tmpDir, "moved.py"))).toBe(GREETED);
	});

	/** An envelope that parses to nothing must be an error, not a quiet success.
	 * Reporting "applied" for a patch that touched no file is the silent no-op the
	 * model would build its next step on. */
	it("refuses an envelope that names no files", async () => {
		await expect(
			editTool("apply_patch").execute("a7", { input: ["*** Begin Patch", "*** End Patch", ""].join("\n") }),
		).rejects.toThrow();
	});
});

describe("hashline mode", () => {
	/**
	 * The default mode, and until now only its REFUSAL path was covered. `SWAP`
	 * replaces an inclusive line range with the body rows beneath it. The whole
	 * file is compared, because hashline edits by LINE NUMBER: an off-by-one lands
	 * a correct-looking payload on the wrong line, and only a full comparison
	 * catches that.
	 */
	it("applies a SWAP to the named line and leaves the rest byte-identical", async () => {
		const file = await seed();
		const header = await hashlineHeader(file);
		await editTool("hashline").execute("h1", {
			input: [header, "SWAP 2.=2:", '+    print("Hello")'].join("\n"),
		});
		expect(await read(file)).toBe(GREETED);
	});

	/** `DEL` takes no body and removes the range outright. Asserted on the whole
	 * file so a deletion that also ate the following line fails here. */
	it("applies a DEL that removes exactly the named line", async () => {
		const file = await seed();
		const header = await hashlineHeader(file);
		await editTool("hashline").execute("h2", { input: [header, "DEL 2.=2"].join("\n") });
		expect(await read(file)).toBe(ORIGINAL.replace('    print("Hi")\n', ""));
	});

	/** `INS.POST` adds without replacing, which is the operation a widened SWAP
	 * would get wrong by silently dropping the lines it retyped. */
	it("applies an INS.POST that adds a line without disturbing its neighbours", async () => {
		const file = await seed();
		const header = await hashlineHeader(file);
		await editTool("hashline").execute("h3", {
			input: [header, "INS.POST 2:", '+    print("extra")'].join("\n"),
		});
		expect(await read(file)).toBe(ORIGINAL.replace('    print("Hi")\n', '    print("Hi")\n    print("extra")\n'));
	});

	/**
	 * THE staleness contract, now asserted against the FILE and not only the
	 * error. A tag names the snapshot the line numbers came from; if the file
	 * moved on, those numbers point at different code, and applying anyway would
	 * write a correct payload to the wrong place.
	 */
	it("refuses a stale tag and leaves the file untouched", async () => {
		const file = await seed();
		const header = await hashlineHeader(file);
		// Change the file under the snapshot the header certifies.
		await fs.writeFile(file, `# a new first line\n${ORIGINAL}`);
		const afterMutation = await read(file);
		await expect(
			editTool("hashline").execute("h4", { input: [header, "SWAP 2.=2:", "+whatever"].join("\n") }),
		).rejects.toThrow();
		expect(await read(file)).toBe(afterMutation);
	});
});

describe("every mode reaches the same file through the same resolution", () => {
	/**
	 * A relative path must resolve against the SESSION cwd, not `process.cwd()`.
	 * This is shared machinery, which is exactly why it is worth checking per
	 * mode: a mode that resolved against the process directory would work in a
	 * test that happened to run from the right place and fail for a real user.
	 *
	 * Written as one test per mode rather than a table, because each mode takes a
	 * differently shaped `edits` array and a union of the two is not a valid
	 * parameter type.
	 */
	it("resolves a relative path against session cwd in replace mode", async () => {
		await seed();
		await editTool("replace").execute("rel-replace", {
			path: "app.py",
			edits: [{ old_text: '    print("Hi")', new_text: '    print("Hello")' }],
		});
		expect(await read(path.join(tmpDir, "app.py"))).toBe(GREETED);
	});

	it("resolves a relative path against session cwd in patch mode", async () => {
		await seed();
		await editTool("patch").execute("rel-patch", {
			path: "app.py",
			edits: [{ op: "update", diff: '@@ def greet(name):\n-    print("Hi")\n+    print("Hello")\n' }],
		});
		expect(await read(path.join(tmpDir, "app.py"))).toBe(GREETED);
	});
});
