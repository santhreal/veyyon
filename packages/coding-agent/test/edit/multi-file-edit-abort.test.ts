/**
 * Cancelling a multi-step edit stops it, and says exactly how far it got.
 *
 * WHY THIS SUITE EXISTS (TOOLE-1-ABORT). `edit-abort-leaves-original.test.ts`
 * covers one file: interrupt the write, the file keeps its old bytes. That
 * guarantee comes from `commitFileContentAtomic`, which refuses to rename once
 * the signal has fired, and it is genuinely enough for a single content
 * rewrite. It is not enough for an `apply_patch` that touches four files or a
 * `patch` that applies six entries to one, and the gap was invisible precisely
 * because the single-file case looked so well covered.
 *
 * Two things were wrong, and this suite is the reason both are now fixed.
 *
 * The loops never checked the signal between steps. They relied on the
 * innermost atomic write noticing, which covers a content rewrite and nothing
 * else: a `*** Delete File:` in the same patch does not go through that path, so
 * a cancelled patch would go on to delete a file after the operator had already
 * said stop. That case is pinned below, and it is the one an atomic write can
 * never have protected.
 *
 * And an abort caught mid-sequence was folded into the ordinary error result:
 * `isError: true` with the text "Error editing X: Operation aborted". The tool
 * RESOLVED. Nothing downstream could tell a cancellation from a hunk that failed
 * to match, so the agent loop's reasonable response to a failed edit, re-read
 * and re-issue, was also its response to the operator pressing Escape. The abort
 * now propagates as a `ToolAbortError` and carries the applied/not-applied
 * summary in its own message, so keeping the type costs nothing.
 *
 * Everything here asserts real bytes on a real temp filesystem through the real
 * `EditTool`. "The file still exists" would pass on a file that lost its
 * contents, and "an error was thrown" would pass on the exact silent-resolve
 * shape that made this survive.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { EditTool } from "@veyyon/coding-agent/edit";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/** The bytes each seeded file starts from. Distinct per file so a test that
 * asserts "unchanged" cannot pass by comparing a file against its neighbour. */
const ORIGINAL = (tag: string): string => `const tag = "${tag}";\nexport default tag;\n`;

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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-edit-abort-"));
});

afterEach(async () => {
	if (tmpDir) {
		await removeWithRetries(tmpDir);
		tmpDir = "";
	}
});

function editTool(mode: "patch" | "apply_patch"): EditTool {
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

/** Seed `name` with {@link ORIGINAL} content tagged by its own stem. */
async function seed(name: string): Promise<string> {
	const file = path.join(tmpDir, name);
	await fs.writeFile(file, ORIGINAL(path.parse(name).name));
	return file;
}

/** Let a rename or an unlink that was already in flight land before observing. */
async function settle(): Promise<void> {
	await Bun.sleep(60);
}

/** An `apply_patch` envelope that rewrites the tag line of each given file. */
function updatePatch(files: readonly string[]): string {
	const body = files.flatMap(file => [
		`*** Update File: ${file}`,
		"@@",
		`-const tag = "${path.parse(file).name}";`,
		`+const tag = "REWRITTEN";`,
	]);
	return ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
}

/** Read a file, or `null` when it is gone. Distinguishes "deleted" from "empty". */
async function readOrNull(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return null;
	}
}

describe("apply_patch across several files, cancelled partway", () => {
	/**
	 * Abort from inside the progress callback, which is the interrupt Ctrl-C
	 * actually produces. `executeApplyPatchPerFile` calls `onUpdate` after every
	 * file except the last, so aborting on the FIRST callback puts the signal in
	 * the window between file one and file two on every run, with no sleep and no
	 * race.
	 */
	async function abortAfterFirstFile(files: readonly string[]): Promise<Error> {
		const controller = new AbortController();
		let updates = 0;
		try {
			await editTool("apply_patch").execute("e1", { input: updatePatch(files) } as never, controller.signal, () => {
				updates += 1;
				if (updates === 1) controller.abort();
			});
		} catch (err) {
			await settle();
			return err as Error;
		}
		await settle();
		throw new Error("expected the cancelled patch to reject, but it resolved");
	}

	it("does not touch the files it had not reached", async () => {
		// THE HEADLINE. The first file is rewritten, and everything after the
		// cancellation keeps its own original bytes.
		const [a, b, c] = [await seed("a.ts"), await seed("b.ts"), await seed("c.ts")];

		await abortAfterFirstFile([a, b, c]);

		expect(await fs.readFile(b, "utf8")).toBe(ORIGINAL("b"));
		expect(await fs.readFile(c, "utf8")).toBe(ORIGINAL("c"));
	});

	it("keeps the file it had already applied, rather than half-undoing the patch", async () => {
		// The other half, and it is a contract rather than an oversight. There is
		// no rollback: a cancelled patch is a partial patch, and the honest report
		// is which files moved. Silently reverting the applied file would be a
		// second unrequested write.
		const [a, b] = [await seed("a.ts"), await seed("b.ts")];

		await abortAfterFirstFile([a, b]);

		expect(await fs.readFile(a, "utf8")).toContain('const tag = "REWRITTEN"');
	});

	it("rejects with an abort rather than resolving with an error result", async () => {
		// THE REGRESSION. This used to RESOLVE with `isError: true` and the text
		// "Error editing b.ts: Operation aborted", which is indistinguishable from
		// a hunk that failed to match. The agent loop's answer to a failed edit is
		// to re-read and re-issue; that must not be its answer to Escape.
		const [a, b] = [await seed("a.ts"), await seed("b.ts")];

		const error = await abortAfterFirstFile([a, b]);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect(error.name).toBe("ToolAbortError");
	});

	it("names how far it got, in files, in the abort's own message", async () => {
		// The applied/skipped summary is the only record of which files were
		// rewritten, so it has to survive on the abort itself. Reachable only from
		// an error result, it would be lost the moment the abort kept its type.
		const [a, b, c] = [await seed("a.ts"), await seed("b.ts"), await seed("c.ts")];

		const error = await abortAfterFirstFile([a, b, c]);

		expect(error.message).toContain("cancelled after 1 of 3 files");
		expect(error.message).toContain(`already applied: ${a}`);
		expect(error.message).toContain("NOT applied");
		expect(error.message).toContain(b);
		expect(error.message).toContain(c);
		expect(error.message).toContain("re-read the affected files before re-issuing");
	});

	it("does not carry out a delete that the cancellation preceded", async () => {
		// THE CASE AN ATOMIC WRITE CANNOT COVER, and the reason the signal check
		// had to move into the loop. `commitFileContentAtomic` refuses to rename
		// once the signal fires, which protects a content rewrite. A delete never
		// reaches that function, so a patch whose later hunk removes a file used to
		// remove it after the operator had already cancelled, and nothing about the
		// atomic write would ever have caught it.
		const keep = await seed("keep.ts");
		const doomed = await seed("doomed.ts");
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${keep}`,
			"@@",
			'-const tag = "keep";',
			'+const tag = "REWRITTEN";',
			`*** Delete File: ${doomed}`,
			"*** End Patch",
		].join("\n");
		const controller = new AbortController();

		let error: Error | undefined;
		try {
			await editTool("apply_patch").execute("e1", { input: patch } as never, controller.signal, () => {
				controller.abort();
			});
		} catch (err) {
			error = err as Error;
		}
		await settle();

		expect(error).toBeInstanceOf(ToolAbortError);
		expect(await readOrNull(doomed)).toBe(ORIGINAL("doomed"));
	});

	it("applies nothing when the signal fired before the first file", async () => {
		// The zero case has to read as zero. "cancelled after 1 of 2" here would be
		// an off-by-one in the one number an operator uses to decide what to
		// re-issue.
		const [a, b] = [await seed("a.ts"), await seed("b.ts")];
		const controller = new AbortController();
		controller.abort();

		let error: Error | undefined;
		try {
			await editTool("apply_patch").execute("e1", { input: updatePatch([a, b]) } as never, controller.signal);
		} catch (err) {
			error = err as Error;
		}
		await settle();

		expect(error).toBeInstanceOf(Error);
		expect(await fs.readFile(a, "utf8")).toBe(ORIGINAL("a"));
		expect(await fs.readFile(b, "utf8")).toBe(ORIGINAL("b"));
	});

	it("leaves no staged temp sibling behind", async () => {
		// The bytes are staged in a hidden `.<name>.<pid>.<n>.tmp` sibling. A
		// cancelled patch that leaves those behind litters the user's source tree
		// with content that was explicitly cancelled, and a glob or a build will
		// happily pick one up.
		const [a, b] = [await seed("a.ts"), await seed("b.ts")];

		await abortAfterFirstFile([a, b]);

		expect((await fs.readdir(tmpDir)).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("still applies every file when the signal is never aborted", async () => {
		// The guard on the guard. Every assertion above is satisfied by a tool that
		// refuses to edit anything at all.
		const [a, b, c] = [await seed("a.ts"), await seed("b.ts"), await seed("c.ts")];
		const controller = new AbortController();

		await editTool("apply_patch").execute("e1", { input: updatePatch([a, b, c]) } as never, controller.signal);
		await settle();

		for (const file of [a, b, c]) {
			expect(await fs.readFile(file, "utf8")).toContain('const tag = "REWRITTEN"');
		}
	});
});

describe("several patch entries on one file, cancelled partway", () => {
	/** Three entries that each rewrite a different line of the same file. */
	const THREE_LINES = "const one = 1;\nconst two = 2;\nconst three = 3;\n";

	function entryArgs(file: string): Record<string, unknown> {
		return {
			path: file,
			edits: [
				{ op: "update", diff: "@@\n-const one = 1;\n+const one = 100;\n" },
				{ op: "update", diff: "@@\n-const two = 2;\n+const two = 200;\n" },
				{ op: "update", diff: "@@\n-const three = 3;\n+const three = 300;\n" },
			],
		};
	}

	async function abortAfterFirstEntry(file: string): Promise<Error> {
		const controller = new AbortController();
		let updates = 0;
		try {
			await editTool("patch").execute("e1", entryArgs(file) as never, controller.signal, () => {
				updates += 1;
				if (updates === 1) controller.abort();
			});
		} catch (err) {
			await settle();
			return err as Error;
		}
		await settle();
		throw new Error("expected the cancelled entry sequence to reject, but it resolved");
	}

	it("stops applying entries once the signal has fired", async () => {
		// Entries after the cancellation must not land. Asserting the exact bytes
		// of the untouched lines is what makes this real: a check that the file
		// merely changed would pass on all three entries applying.
		const file = path.join(tmpDir, "entries.ts");
		await fs.writeFile(file, THREE_LINES);

		await abortAfterFirstEntry(file);

		const after = await fs.readFile(file, "utf8");
		expect(after).toContain("const two = 2;");
		expect(after).toContain("const three = 3;");
	});

	it("rejects with an abort rather than an error result", async () => {
		// KEPT as an identity assertion, because the identity IS the contract: the
		// agent loop branches on it. A ToolAbortError stops the turn; anything else
		// is an ordinary failure it answers by retrying the work the operator just
		// cancelled. The message is pinned separately below, so the two cannot
		// drift apart. Same regression as the per-file loop, in the loop that
		// shares its shape.
		const file = path.join(tmpDir, "entries.ts");
		await fs.writeFile(file, THREE_LINES);

		const error = await abortAfterFirstEntry(file);

		expect(error).toBeInstanceOf(ToolAbortError);
	});

	it("counts entries rather than files in its message", async () => {
		// Entries all target one path, so a list of paths would say the same thing
		// three times. The unit an operator needs here is which ENTRY to re-issue.
		const file = path.join(tmpDir, "entries.ts");
		await fs.writeFile(file, THREE_LINES);

		const error = await abortAfterFirstEntry(file);

		expect(error.message).toContain("cancelled after 1 of 3 entries");
		expect(error.message).toContain("already applied: entry 1");
		expect(error.message).toContain("NOT applied: entry 2, entry 3");
	});

	it("still applies every entry when the signal is never aborted", async () => {
		// Non-vacuity, again: the assertions above are all satisfied by a tool that
		// edits nothing.
		const file = path.join(tmpDir, "entries.ts");
		await fs.writeFile(file, THREE_LINES);

		await editTool("patch").execute("e1", entryArgs(file) as never, new AbortController().signal);
		await settle();

		expect(await fs.readFile(file, "utf8")).toBe("const one = 100;\nconst two = 200;\nconst three = 300;\n");
	});
});

describe("the cancellation message pluralizes its own unit", () => {
	/**
	 * A `${unit}s` suffix reads "1 of 3 entrys", which this suite caught on its
	 * first run. It is a small thing that lands at the worst moment of a session,
	 * on the one message an operator reads to decide what to re-issue, so the two
	 * plurals are spelled out and pinned rather than derived.
	 *
	 * Asserted through the real tool for both units, because the helper that
	 * builds the sentence is private to `edit/index.ts` on purpose: it must have
	 * exactly one caller-visible shape, and a direct unit test of a private
	 * formatter would pass while the wiring said something else.
	 */
	it("says entries, not entrys", async () => {
		const file = path.join(tmpDir, "plural.ts");
		await fs.writeFile(file, "const one = 1;\nconst two = 2;\n");
		const controller = new AbortController();
		let updates = 0;

		let error: Error | undefined;
		try {
			await editTool("patch").execute(
				"e1",
				{
					path: file,
					edits: [
						{ op: "update", diff: "@@\n-const one = 1;\n+const one = 100;\n" },
						{ op: "update", diff: "@@\n-const two = 2;\n+const two = 200;\n" },
					],
				} as never,
				controller.signal,
				() => {
					updates += 1;
					if (updates === 1) controller.abort();
				},
			);
		} catch (err) {
			error = err as Error;
		}
		await settle();

		expect(error?.message).toContain("1 of 2 entries");
		expect(error?.message).not.toContain("entrys");
	});

	it("says files for the per-file loop", async () => {
		const [a, b] = [await seed("p1.ts"), await seed("p2.ts")];
		const controller = new AbortController();
		let updates = 0;

		let error: Error | undefined;
		try {
			await editTool("apply_patch").execute("e1", { input: updatePatch([a, b]) } as never, controller.signal, () => {
				updates += 1;
				if (updates === 1) controller.abort();
			});
		} catch (err) {
			error = err as Error;
		}
		await settle();

		expect(error?.message).toContain("1 of 2 files");
	});
});
