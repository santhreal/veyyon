/**
 * SIG-1, edit half: interrupting an edit must leave the file exactly as it was.
 *
 * `test/lsp/aborted-write-does-not-commit.test.ts` proves the primitive refuses
 * to commit after an abort, and `test/tools/write-abort-leaves-original.test.ts`
 * proves the write tool routes its signal into it.
 * This is the same contract for the tool the agent reaches for far more often,
 * and the stakes are higher: an edit is applied to a file the user already has,
 * usually one they did not just create, so a mangled result destroys work rather
 * than an intermediate artifact. All four edit modes commit through the same
 * `commitFileContentAtomic`, so the interesting question is not whether the
 * primitive is atomic (the suites above settle that) but whether every mode
 * routes its signal into it. A mode that quietly drops the signal writes through
 * a cancellation, and the operator is told the opposite of what happened.
 *
 * So each mode is asked the same two questions, and the answers are compared
 * against the file's exact bytes rather than against the tool's return value.
 *
 * The wait before each assertion is load-bearing, for the reason spelled out in
 * the write suite: the entry guard races the tool against the signal, so the
 * rejection can arrive while the write it started is still in flight. Asserting
 * immediately would pass even if the edit landed a moment later.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { EditTool } from "@veyyon/coding-agent/edit";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/** The file every mode starts from, trailing newline included: a mode that drops
 * it changes the file in a way a diff is happy to hide. */
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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-abort-"));
});

afterEach(async () => {
	if (tmpDir) {
		await removeWithRetries(tmpDir);
		tmpDir = "";
	}
});

function editTool(mode: "replace" | "patch" | "apply_patch"): EditTool {
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

async function seed(name: string): Promise<string> {
	const file = path.join(tmpDir, name);
	await fs.writeFile(file, ORIGINAL);
	return file;
}

/** Outlive a commit that may still be in flight when the rejection arrives. */
async function settle(): Promise<void> {
	await Bun.sleep(60);
}

/** Everything in the working directory, so a staged temp file cannot hide. */
async function entries(): Promise<string[]> {
	return (await fs.readdir(tmpDir)).sort();
}

/** The edit each mode applies, expressed in that mode's own arguments. */
function editArgs(mode: "replace" | "patch" | "apply_patch", file: string): Record<string, unknown> {
	if (mode === "replace") {
		return { path: file, edits: [{ old_text: '    print("Hi")', new_text: '    print("Hello")' }] };
	}
	if (mode === "patch") {
		return {
			path: file,
			edits: [{ op: "update", diff: '@@ def greet(name):\n-    print("Hi")\n+    print("Hello")\n' }],
		};
	}
	return {
		input: [
			"*** Begin Patch",
			`*** Update File: ${file}`,
			"@@",
			'-    print("Hi")',
			'+    print("Hello")',
			"*** End Patch",
		].join("\n"),
	};
}

/** Run an edit under an already-aborted signal and capture the rejection. */
async function abortedEdit(mode: "replace" | "patch" | "apply_patch", file: string): Promise<Error> {
	const controller = new AbortController();
	controller.abort();
	try {
		await editTool(mode).execute("e1", editArgs(mode, file) as never, controller.signal);
	} catch (err) {
		await settle();
		return err as Error;
	}
	await settle();
	throw new Error(`expected the interrupted ${mode} edit on ${file} to reject, but it resolved`);
}

for (const mode of ["replace", "patch", "apply_patch"] as const) {
	describe(`${mode} mode, interrupted`, () => {
		it("leaves the file byte-identical to what it was before the edit", async () => {
			// The whole file is compared, not the edited region: a mode that
			// half-applied its change would still leave the anchor line looking
			// right while the rest of the file moved.
			const file = await seed(`${mode}-intact.py`);

			await abortedEdit(mode, file);

			expect(await fs.readFile(file, "utf8")).toBe(ORIGINAL);
		});

		it("leaves no staged temp sibling in the directory", async () => {
			// A cancelled edit that litters `.name.<pid>.<n>.tmp` files puts content
			// the user explicitly cancelled where a build or a glob can pick it up.
			const file = await seed(`${mode}-debris.py`);

			await abortedEdit(mode, file);

			expect(await entries()).toEqual([`${mode}-debris.py`]);
		});
	});
}

describe("edit modes still apply normally under a signal that was never aborted", () => {
	// The control for all of the above. A guard that rejected every edit carrying
	// a signal would satisfy every assertion in this file while breaking the
	// product outright, since the agent always passes one.
	const EDITED = ORIGINAL.replace('    print("Hi")', '    print("Hello")');

	for (const mode of ["replace", "patch", "apply_patch"] as const) {
		it(`${mode} mode applies the edit`, async () => {
			const file = await seed(`${mode}-control.py`);
			const controller = new AbortController();

			await editTool(mode).execute("e1", editArgs(mode, file) as never, controller.signal);

			expect(await fs.readFile(file, "utf8")).toBe(EDITED);
		});
	}
});
