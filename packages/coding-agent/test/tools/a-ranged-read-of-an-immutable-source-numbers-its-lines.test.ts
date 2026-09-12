/**
 * WHY THIS SUITE EXISTS:
 *
 * `read arc.zip:src/a.ts:2-3` returned five bare lines (the two requested plus context) and a
 * notice saying which lines they were, with nothing on the lines themselves to say which printed
 * row was line 2. Hashlines are suppressed for an immutable source (archive member, `artifact://`,
 * `memory://`, ...) because there is no edit path for it, and plain line numbers default off, so a
 * ranged read of an immutable source lost its line identity while the same read of a file on disk
 * kept it.
 *
 * CLASS: every read of an immutable source that names lines must print them numbered, whatever
 * `readLineNumbers` is set to. The spelling is the plain `N|` gutter (`41|def alpha():` in the read
 * prompt), never the `N:` of a hashline body: `N:` marks a line the edit tool can anchor on, and an
 * immutable source has no edit path. `resolveFileDisplayMode` is the one owner of that decision, so the
 * first block sweeps its whole option space and pins the invariant; the second drives the three
 * read-tool paths that construct a display mode for an immutable source (in-memory single range,
 * in-memory multi range, streamed artifact) through the real tool.
 *
 * DOES NOT CATCH: an internal-URL handler that reports `immutable: false` for content that cannot
 * be edited (that is a handler decision, pinned by the handler suites), or a future read path that
 * builds its own display mode without going through `resolveFileDisplayMode`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { resolveFileDisplayMode } from "@veyyon/coding-agent/utils/file-display-mode";
import { zip } from "@veyyon/coding-agent/utils/zip";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

/** The output before any trailing `[...]` continuation notice. */
function body(output: string): string {
	return output.split("\n\n[")[0];
}

const MEMBER = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].join("\n");

describe("resolveFileDisplayMode numbers a ranged read of an immutable source", () => {
	const settingsFor = (readLineNumbers: boolean, editMode: string) => ({
		get: (key: "readLineNumbers" | "edit.mode") => (key === "readLineNumbers" ? readLineNumbers : editMode),
	});

	// Every combination of the resolver's inputs, so the invariant holds on all of them and not
	// only on the reported one (`readLineNumbers: false`, hashline mode, archive member).
	for (const readLineNumbers of [false, true]) {
		for (const editMode of ["hashline", "replace"]) {
			for (const hasEditTool of [true, false]) {
				for (const immutable of [true, false]) {
					for (const raw of [true, false]) {
						for (const ranged of [true, false]) {
							const label = `readLineNumbers=${readLineNumbers} edit.mode=${editMode} hasEditTool=${hasEditTool} immutable=${immutable} raw=${raw} ranged=${ranged}`;
							it(label, () => {
								const mode = resolveFileDisplayMode(
									{ hasEditTool, settings: settingsFor(readLineNumbers, editMode) },
									{ raw, immutable, ranged },
								);
								// Raw output is verbatim: never numbered, never hashed.
								if (raw) {
									expect(mode).toEqual({ hashLines: false, lineNumbers: false });
									return;
								}
								// An immutable source never mints anchors.
								if (immutable) expect(mode.hashLines).toBe(false);
								// The invariant under test: a ranged read of an immutable source is numbered.
								if (immutable && ranged) expect(mode.lineNumbers).toBe(true);
								// The pre-existing contract: otherwise numbers follow hashlines or the setting.
								if (!immutable || !ranged) expect(mode.lineNumbers).toBe(mode.hashLines || readLineNumbers);
							});
						}
					}
				}
			}
		}
	}
});

describe("the read tool numbers a ranged read of an immutable source", () => {
	let tmpDir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let archivePath: string;

	function session(): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactDir,
			// Defaults: hashline edit mode, `readLineNumbers` off. The defect needs both.
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-immutable-ranged-"));
		artifactDir = path.join(tmpDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await fs.writeFile(path.join(artifactDir, "0.bash.log"), MEMBER);
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		archivePath = path.join(tmpDir, "arc.zip");
		await fs.writeFile(archivePath, zip({ "src/a.ts": new TextEncoder().encode(MEMBER) }));
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await removeWithRetries(tmpDir);
	});

	const sources = [
		{ name: "archive member", target: () => `${archivePath}:src/a.ts` },
		{ name: "artifact", target: () => "artifact://0" },
	] as const;

	for (const source of sources) {
		it(`${source.name}: a single-range read prints N| on every row, requested and context alike`, async () => {
			const result = await new ReadTool(session()).execute("r", { path: `${source.target()}:2-3` });
			const rows = body(getText(result)).split("\n");
			expect(rows).toContain("2|bravo");
			expect(rows).toContain("3|charlie");
			// Context rows are numbered too, so the requested rows are told apart from the padding.
			for (const row of rows) expect(row).toMatch(/^\d+\|/);
			// Never a hashline header or a hashline `N:` row: the source cannot be edited.
			expect(getText(result)).not.toMatch(/^\[[^\]]+#[0-9A-F]{4}\]/m);
			expect(getText(result)).not.toMatch(/^\d+:/m);
		});

		it(`${source.name}: a multi-range read prints N| on every row`, async () => {
			const result = await new ReadTool(session()).execute("r", { path: `${source.target()}:1-2,5-6` });
			const rows = body(getText(result)).split("\n");
			expect(rows).toContain("1|alpha");
			expect(rows).toContain("5|echo");
			expect(rows).toContain("6|foxtrot");
			for (const row of rows) expect(row === "" || /^\d+\|/.test(row) || row.startsWith("…")).toBe(true);
		});

		it(`${source.name}: a raw ranged read stays verbatim`, async () => {
			const result = await new ReadTool(session()).execute("r", { path: `${source.target()}:raw:2-3` });
			// Verbatim body; a continuation notice after it is the same one a raw read of a file gets.
			expect(body(getText(result))).toBe("bravo\ncharlie");
		});

		it(`${source.name}: an unranged read stays bare when readLineNumbers is off`, async () => {
			const result = await new ReadTool(session()).execute("r", { path: source.target() });
			const rows = body(getText(result)).split("\n");
			expect(rows[0]).toBe("alpha");
			expect(rows).not.toContain("1|alpha");
		});
	}
});
