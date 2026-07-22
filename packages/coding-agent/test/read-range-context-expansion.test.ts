import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/read";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";

// WHY THIS SUITE EXISTS (BACKLOG DOG-4)
// -------------------------------------
// A bounded line range like `:1-5` intentionally returns a few MORE lines than
// requested: read pads a constrained range with a little surrounding context (1
// line before where the offset was constrained, 3 lines after) so the reader sees
// where the range sits. A dogfood agent that asked for `:1-5` and got 8 numbered
// lines read this as "read over-delivers / is unpredictable". It is neither, but
// the padding was undocumented and unlocked. `:raw` deliberately returns EXACTLY
// the requested lines with no padding and no line prefixes, for paste-back-into-
// tool workflows. This suite locks BOTH contracts against real byte output so the
// expansion (and raw's exactness) cannot silently drift: the read.md doc now
// promises this behavior, and these tests prove the runtime matches the doc.

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	// Disable structural summarization so a selector read returns literal lines
	// regardless of language heuristics.
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as unknown as ToolSession;
}

function makeNumberedContent(lines: number): string {
	// Distinctive tokens so a rendered line number is never a substring of another.
	return Array.from({ length: lines }, (_, i) => `content_${String(i + 1).padStart(3, "0")}_x`).join("\n");
}

/** The 1-based line numbers actually rendered, read from each `N:` line prefix. */
function renderedLineNumbers(text: string): number[] {
	const nums: number[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^(\d+):/);
		if (m) nums.push(Number(m[1]));
	}
	return nums;
}

describe("read tool range context expansion", () => {
	let tmpDir: string;
	let filePath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-context-test-"));
		filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(20));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("pads a range constrained only at the end (`:1-5`) with 3 trailing context lines and no leading", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-1-5", { path: `${filePath}:1-5` }));

		// 5 requested (1-5) + 3 trailing context = lines 1..8; line 9 must NOT appear.
		expect(renderedLineNumbers(text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(text).toContain("content_005_x");
		expect(text).toContain("content_008_x");
		expect(text).not.toContain("content_009_x");
	});

	it("pads a range constrained on both sides (`:5-8`) with 1 leading and 3 trailing context lines", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-5-8", { path: `${filePath}:5-8` }));

		// 1 leading (line 4) + 4 requested (5-8) + 3 trailing (9-11) = lines 4..11.
		expect(renderedLineNumbers(text)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
		expect(text).not.toContain("content_003_x");
		expect(text).not.toContain("content_012_x");
	});

	it("returns EXACTLY the requested range with `:raw`: no context padding, no line prefixes", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-raw-1-5", { path: `${filePath}:raw:1-5` }));

		// Raw is verbatim: precisely lines 1-5, no added context, no `N:` prefixes.
		expect(renderedLineNumbers(text)).toEqual([]);
		expect(text).toContain("content_001_x");
		expect(text).toContain("content_005_x");
		expect(text).not.toContain("content_006_x");
		// The five requested lines, in order, are the whole payload.
		const bodyLines = text.split("\n").filter(l => l.startsWith("content_"));
		expect(bodyLines).toEqual(["content_001_x", "content_002_x", "content_003_x", "content_004_x", "content_005_x"]);
	});
});
