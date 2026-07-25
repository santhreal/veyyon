// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures ARE TypeScript
// source being edited, so `${name}` is content under test, not an accidental placeholder.
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

/**
 * TOOLE-2: an edit whose anchor no longer describes the file must be REFUSED,
 * never applied to whatever the file has become.
 *
 * Every edit is written against a file the agent read earlier, and the gap
 * between those two moments is real: a formatter runs, the user saves in their
 * editor, a parallel agent lands a change, a rebase moves the file. If the tool
 * applied the edit regardless, it would write a change designed for text that is
 * no longer there, and the result would be a plausible-looking file that is
 * silently wrong — the worst outcome available, because nothing in the
 * transcript would show it happened.
 *
 * The anchor is the `old_text` itself: it is required to be present, and
 * required to be unambiguous. That makes the refusals in this file the actual
 * staleness detector, and each one is asserted here with a real file mutated
 * between the read and the edit rather than a hand-built error object.
 *
 * The tests use a REAL read followed by a REAL edit so the sequence under test
 * is the one the agent performs. Every refusal is checked for naming what went
 * wrong, because a refusal the model cannot interpret becomes a retry loop.
 */
describe("an edit anchored to content that changed under it", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir = "";

	const ORIGINAL = ["export function greet(name: string) {", "\treturn `hello ${name}`;", "}", ""].join("\n");

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-anchor-"));
	});

	afterEach(async () => {
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = "";
		}
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
				"edit.mode": "replace",
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	/** Seed a file and read it through the real tool, as the agent would. */
	async function seedAndRead(name: string): Promise<string> {
		const file = path.join(tmpDir, name);
		await fs.writeFile(file, ORIGINAL);
		await new ReadTool(session()).execute("r1", { path: file });
		return file;
	}

	/** Attempt an edit and return the rejection, failing loudly if it succeeded. */
	async function expectRefusal(file: string, oldText: string, newText: string): Promise<Error> {
		try {
			await new EditTool(session()).execute("e1", {
				path: file,
				edits: [{ old_text: oldText, new_text: newText }],
			});
		} catch (err) {
			return err as Error;
		}
		throw new Error(`expected the edit to ${file} to be refused, but it was applied`);
	}

	describe("when the anchored text is gone", () => {
		it("refuses instead of writing the edit somewhere else", async () => {
			// The core case. Someone renamed the parameter after the read; the text
			// the edit describes does not exist any more, so there is no correct place
			// to put the replacement.
			const file = await seedAndRead("gone.ts");
			await fs.writeFile(file, ORIGINAL.replace("name: string", "who: string"));

			await expectRefusal(file, "name: string", "name?: string");

			expect(await fs.readFile(file, "utf8")).toContain("who: string");
		});

		it("the refusal names the text it could not find", async () => {
			// Without the anchor text in the message the model cannot tell WHICH of
			// several edits went stale, and its only move is to retry blind.
			const file = await seedAndRead("named.ts");
			await fs.writeFile(file, ORIGINAL.replace("name: string", "who: string"));

			const error = await expectRefusal(file, "name: string", "name?: string");

			expect(error.message).toContain("name: string");
		});

		it("leaves the file byte-identical to what was on disk", async () => {
			// A refusal that still touched the file (a rewrite, a normalization, a
			// truncation) would be a silent mutation dressed up as an error.
			const file = await seedAndRead("untouched.ts");
			const changed = ORIGINAL.replace("hello", "hi");
			await fs.writeFile(file, changed);

			await expectRefusal(file, "`hello ${name}`", "`hey ${name}`");

			expect(await fs.readFile(file, "utf8")).toBe(changed);
		});
	});

	describe("when the change made the anchor AMBIGUOUS", () => {
		it("refuses rather than picking one of the matches", async () => {
			// The subtle one, and the reason presence alone is not enough. A copy-paste
			// or a merge can duplicate the anchored line, and an edit that quietly
			// takes the first match has a 50% chance of changing the wrong call site.
			const file = await seedAndRead("ambiguous.ts");
			await fs.writeFile(file, `${ORIGINAL}\n${ORIGINAL}`);

			const error = await expectRefusal(file, "\treturn `hello ${name}`;", "\treturn `hi ${name}`;");

			expect(error.message).toMatch(/occurrence|multiple|ambiguous/i);
		});

		it("says how many matches it found, so the fix is obvious", async () => {
			// "Ambiguous" alone leaves the model guessing how much context to add. A
			// count tells it the anchor needs widening and by roughly how much.
			const file = await seedAndRead("counted.ts");
			await fs.writeFile(file, `${ORIGINAL}\n${ORIGINAL}`);

			const error = await expectRefusal(file, "\treturn `hello ${name}`;", "\treturn `hi ${name}`;");

			expect(error.message).toContain("2");
		});

		it("both copies are left alone", async () => {
			const file = await seedAndRead("both-intact.ts");
			const doubled = `${ORIGINAL}\n${ORIGINAL}`;
			await fs.writeFile(file, doubled);

			await expectRefusal(file, "\treturn `hello ${name}`;", "\treturn `hi ${name}`;");

			expect(await fs.readFile(file, "utf8")).toBe(doubled);
		});
	});

	describe("when the file is gone entirely", () => {
		it("refuses and does not recreate it from the edit", async () => {
			// Deletion between read and edit is a rebase, a `git clean`, or another
			// agent. Recreating the file from `new_text` would resurrect a file
			// someone deliberately removed, holding only the fragment being edited.
			const file = await seedAndRead("deleted.ts");
			await fs.rm(file);

			const error = await expectRefusal(file, "name: string", "name?: string");

			expect(error.message).toMatch(/ENOENT|not found|does not exist/i);
			expect(await fs.exists(file)).toBe(false);
		});

		it("refuses when the path became a DIRECTORY", async () => {
			// Rarer, and worse if mishandled: writing through would have to clobber a
			// directory. Pinned so the failure stays an error rather than data loss.
			const file = await seedAndRead("now-a-dir.ts");
			await fs.rm(file);
			await fs.mkdir(file);
			await fs.writeFile(path.join(file, "inside.txt"), "still here\n");

			await expectRefusal(file, "name: string", "name?: string");

			expect((await fs.stat(file)).isDirectory()).toBe(true);
			expect(await fs.readFile(path.join(file, "inside.txt"), "utf8")).toBe("still here\n");
		});
	});

	describe("what must still work", () => {
		it("an unchanged file edits normally", async () => {
			// The control. Every refusal above is satisfied by a tool that refuses
			// every edit, which would be a total outage rather than a safety property.
			const file = await seedAndRead("unchanged.ts");

			await new EditTool(session()).execute("e1", {
				path: file,
				edits: [{ old_text: "name: string", new_text: "name?: string" }],
			});

			expect(await fs.readFile(file, "utf8")).toContain("name?: string");
		});

		it("a change ELSEWHERE in the file does not block an edit whose anchor survived", async () => {
			// The deliberate boundary of this contract, and the reason the anchor is
			// content rather than a whole-file hash. Another agent adding an unrelated
			// function must not invalidate a still-valid edit, or concurrent work
			// would deadlock on every save. The anchor still uniquely identifies its
			// target, so the edit is applied and the other change is preserved.
			const file = await seedAndRead("elsewhere.ts");
			await fs.writeFile(file, `${ORIGINAL}\nexport const unrelated = 1;\n`);

			await new EditTool(session()).execute("e1", {
				path: file,
				edits: [{ old_text: "name: string", new_text: "name?: string" }],
			});

			const after = await fs.readFile(file, "utf8");
			expect(after).toContain("name?: string");
			expect(after).toContain("export const unrelated = 1;");
		});
	});
});
