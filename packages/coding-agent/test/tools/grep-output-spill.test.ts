import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { DEFAULT_MAX_BYTES } from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";
import { GrepTool } from "../../src/tools/grep";
import { makeToolSession } from "../helpers/tool-session";

// TW-9: a single grep query can return a match set that dwarfs the inline floor
// (the line/column budget alone permits well over a megabyte). A 51KB grep
// result measured in a real session was carried for 642 turns (~8.3M
// token-turns, the single largest context-tax item). Big results must route
// through the same artifact spill bash uses, with the full set recoverable.

const HEAD_SENTINEL = "HEADSENTINEL7f3a";
const TAIL_SENTINEL = "TAILSENTINEL9c2b";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("GrepTool oversized-result spill (TW-9)", () => {
	let tmpDir: string;
	let artifactDir: string;
	let idToPath: Map<string, string>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-spill-"));
		artifactDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactDir);
		idToPath = new Map();
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(): ToolSession {
		let counter = 0;
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			allocateOutputArtifact: async (kind: string) => {
				counter += 1;
				const id = `${kind}-${counter}`;
				const filePath = path.join(artifactDir, `${id}.txt`);
				idToPath.set(id, filePath);
				return { path: filePath, id };
			},
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		});
	}

	it("spills a >50KB match set to an artifact and keeps a bounded inline body", async () => {
		// 200 long matching lines (the single-file cap). Each line is ~470 chars,
		// under the 512-column cap, so nothing is line-truncated; the total (~85KB
		// rendered) is well over DEFAULT_MAX_BYTES (50KB). Frame the first and last
		// shown line with sentinels so we can prove the full set survives in the
		// artifact.
		const pad = "x".repeat(450);
		const lines: string[] = [];
		for (let i = 0; i < 200; i++) {
			let tag = "";
			if (i === 0) tag = HEAD_SENTINEL;
			else if (i === 199) tag = TAIL_SENTINEL;
			lines.push(`NEEDLE ${tag} ${pad}`);
		}
		const file = path.join(tmpDir, "big.txt");
		await fs.writeFile(file, `${lines.join("\n")}\n`);

		const tool = new GrepTool(createSession());
		const result = await tool.execute("call-grep-big", { pattern: "NEEDLE", path: "big.txt" });

		const text = getResultText(result);
		const textBytes = Buffer.byteLength(text, "utf-8");

		// The inline body is bounded near the budget (plus a small footer), not the
		// full ~85KB it matched.
		expect(textBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 128);
		expect(result.details?.truncated).toBe(true);
		expect(text).toContain("artifact://");
		expect(text).toContain(HEAD_SENTINEL);

		// The artifact holds the FULL match set: both sentinels, strictly larger
		// than the elided inline body and over the budget.
		const match = text.match(/artifact:\/\/([^\]\s]+)/);
		expect(match).not.toBeNull();
		const artifactId = match![1];
		const artifactPath = idToPath.get(artifactId);
		expect(artifactPath).toBeDefined();
		const artifactText = await fs.readFile(artifactPath!, "utf-8");
		const artifactBytes = Buffer.byteLength(artifactText, "utf-8");
		expect(artifactBytes).toBeGreaterThan(DEFAULT_MAX_BYTES);
		expect(artifactBytes).toBeGreaterThan(textBytes);
		expect(artifactText).toContain(HEAD_SENTINEL);
		expect(artifactText).toContain(TAIL_SENTINEL);
	});

	it("leaves a small match set inline with no artifact spill", async () => {
		const file = path.join(tmpDir, "small.txt");
		await fs.writeFile(file, "NEEDLE small-marker-4d1e alpha\nNEEDLE beta\nNEEDLE gamma\n");

		const tool = new GrepTool(createSession());
		const result = await tool.execute("call-grep-small", { pattern: "NEEDLE", path: "small.txt" });

		const text = getResultText(result);
		expect(text).toContain("small-marker-4d1e");
		expect(text).not.toContain("artifact://");
		expect(text).not.toContain("elided");
		expect(idToPath.size).toBe(0);
	});
});
