/**
 * A write records that the model has seen every line it wrote.
 *
 * WHY THIS SUITE EXISTS. The hashline patcher refuses an edit anchored at a
 * line the model never saw, and it decides that from `snapshot.seenLines`. The
 * gate opens with `if (!seen || seen.size === 0) return`, so a snapshot carrying
 * NO provenance does not satisfy the gate, it SWITCHES THE GATE OFF. The
 * post-write snapshot used to be recorded exactly that way: `record(key, text)`
 * with no third argument. Post-write edits therefore worked for a reason nobody
 * had written down, and the reason was "the check was skipped" rather than "the
 * check passed".
 *
 * That is a latent inversion. The day the empty set is read the other way round
 * -- as "no lines have been seen", which is the more literal reading of the
 * field name -- every post-write edit starts failing with an unseen-anchor
 * error, and the file that has to change is the writer, not the gate. Recording
 * the true provenance now (a write is the one case where the model demonstrably
 * saw every byte, having produced them) makes the gate RUN and PASS, and the
 * behaviour stops depending on which way an empty set is read.
 *
 * The suite pins both halves: the write's provenance is exactly every line, and
 * the gate it satisfies is genuinely live. The second half matters most -- a
 * test that only checks the post-write edit succeeds cannot tell a satisfied
 * gate from a skipped one, which is the very confusion being removed, so the
 * negative twin drives a partial read and proves the same gate refuses there.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	allLineNumbers,
	canonicalSnapshotKey,
	contiguousLineNumbers,
	getFileSnapshotStore,
} from "@veyyon/coding-agent/edit/file-snapshot-store";
import { HashlineFilesystem } from "@veyyon/coding-agent/edit/hashline/filesystem";
import { writethroughNoop } from "@veyyon/coding-agent/lsp";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { Patch, Patcher } from "@veyyon/hashline";
import { removeWithRetries } from "@veyyon/utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	} as ToolSession;
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

/** A ten-line file, so an anchor deep in the body is genuinely out of a head read. */
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n";

async function applyPatch(session: ToolSession, cwd: string, input: string): Promise<string> {
	const patch = Patch.parse(input, { cwd });
	expect(patch.sections).toHaveLength(1);
	const filesystem = new HashlineFilesystem({
		session,
		writethrough: writethroughNoop,
		beginDeferredDiagnosticsForPath: () => {
			throw new Error("deferred diagnostics unused with writethroughNoop");
		},
	});
	const patcher = new Patcher({ fs: filesystem, snapshots: getFileSnapshotStore(session) });
	const prepared = await patcher.prepare(patch.sections[0]!);
	const sectionResult = await patcher.commit(prepared);
	return sectionResult.op;
}

describe("contiguousLineNumbers", () => {
	it("numbers a run of lines from a 1-indexed start, inclusive of the start", () => {
		// Off-by-one here silently shifts every producer's provenance by a line,
		// which surfaces much later as an unseen-anchor refusal on a line the
		// model plainly read. The exact array is asserted, not its length.
		expect(contiguousLineNumbers(1, 4)).toEqual([1, 2, 3, 4]);
		expect(contiguousLineNumbers(40, 3)).toEqual([40, 41, 42]);
	});

	it("returns nothing for an empty run rather than the start line", () => {
		// A range read that displayed no lines has seen no lines. Returning
		// `[startLine]` would mark an undisplayed line as seen.
		expect(contiguousLineNumbers(7, 0)).toEqual([]);
		expect(contiguousLineNumbers(7, -1)).toEqual([]);
	});
});

describe("allLineNumbers", () => {
	it("covers every line of multi-line text, counting the last line without a trailing newline", () => {
		expect(allLineNumbers("a\nb\nc")).toEqual([1, 2, 3]);
	});

	it("counts a trailing newline as terminating the last line, not opening a new one", () => {
		// `"a\nb\n"` is two lines. Treating the trailing newline as a third line
		// would record a line number past the end of the file, and the patcher
		// skips out-of-range anchors when revealing, so the error would be
		// silently wrong rather than loud.
		expect(allLineNumbers("a\nb\n")).toEqual([1, 2, 3]);
		expect(allLineNumbers("a\nb\n").at(-1)).toBe(3);
	});

	it("treats empty and single-line text as one line", () => {
		// A write of "" still produced line 1, so the gate must consider it seen.
		expect(allLineNumbers("")).toEqual([1]);
		expect(allLineNumbers("only")).toEqual([1]);
	});

	it("counts the lines the write actually recorded for a ten-line file", () => {
		expect(allLineNumbers(TEN_LINES)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});
});

describe("write tool snapshot provenance", () => {
	let tmpDir: string;

	// Same reason as write-hashline-header.test.ts: the Patcher path reads the
	// process-wide settings singleton, and `Settings.init` is once-per-process,
	// so the suite claims a clean slate and releases it afterwards rather than
	// inheriting or leaking one across files in a CI chunk.
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-seen-lines-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("records every written line as seen, not an empty provenance set", async () => {
		const filePath = path.join(tmpDir, "module.ts");
		const session = createSession(tmpDir);

		const result = await new WriteTool(session).execute("call-1", { path: filePath, content: TEN_LINES });
		const match = HASHLINE_HEADER_LINE.exec(resultText(result).split("\n")[0] ?? "");
		expect(match).not.toBeNull();

		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), match![2]!);
		expect(snapshot).not.toBeNull();
		// The exact set, not its size: recording SOME lines would pass a size
		// check while still refusing an anchor in the part that was missed.
		expect([...(snapshot!.seenLines ?? [])].sort((a, b) => a - b)).toEqual(allLineNumbers(TEN_LINES));
	});

	it("lets a post-write edit anchor at a line no read ever displayed", async () => {
		const filePath = path.join(tmpDir, "config.ts");
		const session = createSession(tmpDir);

		const writeResult = await new WriteTool(session).execute("call-1", { path: filePath, content: TEN_LINES });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

		// Line 9 is deep in the body and was never read back. Under a correct
		// recording the gate runs and finds it seen; under an empty set the gate
		// is skipped and this passes for the wrong reason, which is what the
		// refusal test below distinguishes.
		const op = await applyPatch(session, tmpDir, `${headerLine}\nSWAP 9.=9:\n+const line9 = 900;\n`);
		expect(op).toBe("update");
		expect(await fs.readFile(filePath, "utf8")).toContain("const line9 = 900;");
		expect(await fs.readFile(filePath, "utf8")).toContain("const line8 = 8;");
	});

	it("still refuses an anchor outside a partial read, so the gate above was passed and not skipped", async () => {
		// The negative twin. Without it, "post-write edits work" is equally
		// consistent with the gate being switched off for every snapshot in the
		// session, and the suite would prove nothing about provenance at all.
		const filePath = path.join(tmpDir, "partial.ts");
		await fs.writeFile(filePath, TEN_LINES, "utf8");
		const session = createSession(tmpDir);

		const readResult = await new ReadTool(session).execute("call-1", { path: `${filePath}:1-3` });
		const headerLine = resultText(readResult)
			.split("\n")
			.find(line => HASHLINE_HEADER_LINE.test(line));
		expect(headerLine).toBeDefined();

		// The refusal message is asserted, not merely that something threw: a
		// throw from a mis-parsed patch would satisfy a bare `rejects` and leave
		// the gate unexercised.
		await expect(applyPatch(session, tmpDir, `${headerLine}\nSWAP 9.=9:\n+const line9 = 900;\n`)).rejects.toThrow(
			/never displayed \(it showed/,
		);
		// The file is untouched: a refused edit must not half-apply.
		expect(await fs.readFile(filePath, "utf8")).toBe(TEN_LINES);
	});
});
