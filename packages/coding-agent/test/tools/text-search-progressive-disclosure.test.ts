/**
 * WHY: Broad text searches must bound provider context without losing exact
 * recovery or granting edit authority for omitted lines. This suite drives the
 * production SearchTool and closes compact preview ownership, generic head
 * truncation, warning-dominated byte budgets, and artifact fallback behavior.
 * It does not cover artifact recovery after session replay or concurrent
 * sessions that allocate the same artifact identifier.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@veyyon/coding-agent/edit/file-snapshot-store";
import { inlineCapForTurn } from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { BROAD_SEARCH_INLINE_MAX_BYTES } from "@veyyon/coding-agent/tools/search/text-search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("SearchTool (text) progressive disclosure contract", () => {
	let tmpDir: string;
	let artifactDir: string;
	let idToPath: Map<string, string>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-prog-"));
		artifactDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactDir, { recursive: true });
		idToPath = new Map();
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(opts?: { failArtifacts?: boolean; noStore?: boolean }): ToolSession {
		let counter = 0;
		if (opts?.noStore) {
			return makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getTurnIndex: () => 0,
				getSessionFile: () => null,
				settings: Settings.isolated({ "search.contextBefore": 1, "search.contextAfter": 1 }),
			});
		}
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getTurnIndex: () => 0,
			getSessionFile: () => null,
			allocateOutputArtifact: async (kind: string) => {
				if (opts?.failArtifacts) {
					throw new Error("Simulated artifact allocation failure");
				}
				counter += 1;
				const id = `${kind}-${counter}`;
				const filePath = path.join(artifactDir, `${id}.txt`);
				idToPath.set(id, filePath);
				return { path: filePath, id };
			},
			settings: Settings.isolated({ "search.contextBefore": 1, "search.contextAfter": 1 }),
		});
	}

	it("compacts broad multi-file results exceeding discovery budget while persisting full raw output", async () => {
		// Create 6 files, each containing 5 matches plus padding lines
		for (let fileIndex = 1; fileIndex <= 6; fileIndex++) {
			const lines: string[] = [];
			for (let lineIndex = 1; lineIndex <= 30; lineIndex++) {
				if (lineIndex % 6 === 0) {
					lines.push(`const match_${fileIndex}_${lineIndex} = "NEEDLE_KEYWORD_${fileIndex}_${lineIndex}";`);
				} else {
					lines.push(`const padding_${fileIndex}_${lineIndex} = ${lineIndex};`);
				}
			}
			await fs.writeFile(path.join(tmpDir, `file_${fileIndex}.ts`), `${lines.join("\n")}\n`);
		}

		const session = createSession();
		const tool = new SearchTool(session);
		const result = await tool.execute("call-broad-search", {
			type: "text",
			input: "NEEDLE_KEYWORD",
			path: ".",
		});

		const text = extractText(result);
		expect(text).toContain("artifact://");
		expect(text).toContain("30 matches in 6 files");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(inlineCapForTurn(BROAD_SEARCH_INLINE_MAX_BYTES, 0));
		expect(result.details?.type).toBe("text");
		if (result.details?.type !== "text") throw new Error("Expected text search details");
		expect(result.details.result.truncation?.truncated).toBe(true);
		expect(result.details.result.meta?.truncation?.artifactId).toBeDefined();
		// Check compact structure: only first 2 representative matches per file are shown
		for (let fileIndex = 1; fileIndex <= 6; fileIndex++) {
			expect(text).toContain(`NEEDLE_KEYWORD_${fileIndex}_6`);
			expect(text).toContain(`NEEDLE_KEYWORD_${fileIndex}_12`);
			// The 3rd, 4th, 5th matches should be elided from the inline preview
			expect(text).not.toContain(`NEEDLE_KEYWORD_${fileIndex}_18`);
			expect(text).not.toContain(`NEEDLE_KEYWORD_${fileIndex}_24`);
			expect(text).not.toContain(`NEEDLE_KEYWORD_${fileIndex}_30`);
		}

		// Verify artifact recovery holds the 100% full raw output
		const artifactMatch = text.match(/artifact:\/\/([^\]\s]+)/);
		expect(artifactMatch).not.toBeNull();
		const artifactId = artifactMatch ? artifactMatch[1] : "";
		const artifactPath = idToPath.get(artifactId);
		expect(artifactPath).toBeDefined();
		const artifactText = await fs.readFile(artifactPath!, "utf-8");

		// All matches and context lines exist in the artifact
		for (let fileIndex = 1; fileIndex <= 6; fileIndex++) {
			for (const lineIndex of [6, 12, 18, 24, 30]) {
				expect(artifactText).toContain(`NEEDLE_KEYWORD_${fileIndex}_${lineIndex}`);
			}
		}
	});

	it("preserves deterministic file and match ordering across compact preview and artifact", async () => {
		const fileNames = ["alpha.ts", "bravo.ts", "charlie.ts", "delta.ts"];
		for (const name of fileNames) {
			const lines: string[] = [];
			for (let i = 1; i <= 20; i++) {
				lines.push(`const val_${i} = "SHARED_ORDER_NEEDLE_${name}_${i}";`);
			}
			await fs.writeFile(path.join(tmpDir, name), `${lines.join("\n")}\n`);
		}

		const session = createSession();
		const tool = new SearchTool(session);
		const result = await tool.execute("call-order-search", {
			type: "text",
			input: "SHARED_ORDER_NEEDLE",
			path: ".",
		});

		const text = extractText(result);
		const artifactMatch = text.match(/artifact:\/\/([^\]\s]+)/);
		expect(artifactMatch).not.toBeNull();
		const artifactId = artifactMatch ? artifactMatch[1] : "";
		const artifactText = await fs.readFile(idToPath.get(artifactId)!, "utf-8");

		// In both compact preview and artifact, alpha -> bravo -> charlie -> delta appear in order
		const alphaPos = text.indexOf("alpha.ts");
		const bravoPos = text.indexOf("bravo.ts");
		const charliePos = text.indexOf("charlie.ts");
		const deltaPos = text.indexOf("delta.ts");
		expect(alphaPos).toBeGreaterThan(-1);
		expect(bravoPos).toBeGreaterThan(alphaPos);
		expect(charliePos).toBeGreaterThan(bravoPos);
		expect(deltaPos).toBeGreaterThan(charliePos);

		const artAlpha = artifactText.indexOf("alpha.ts");
		const artBravo = artifactText.indexOf("bravo.ts");
		const artCharlie = artifactText.indexOf("charlie.ts");
		const artDelta = artifactText.indexOf("delta.ts");
		expect(artAlpha).toBeGreaterThan(-1);
		expect(artBravo).toBeGreaterThan(artAlpha);
		expect(artCharlie).toBeGreaterThan(artBravo);
		expect(artDelta).toBeGreaterThan(artCharlie);
	});

	it("records seen lines only for inline preview matches and keeps hidden matches unseen", async () => {
		// Create 4 files with 10 matches each to exceed the 2KB broad discovery budget
		for (const name of ["first.ts", "second.ts", "third.ts", "fourth.ts"]) {
			const lines: string[] = [];
			for (let i = 1; i <= 50; i++) {
				if (i % 5 === 0) {
					lines.push(`const hit_${i} = "SEEN_TEST_TOKEN_${name}_${i}";`);
				} else {
					lines.push(`const pad_${i} = "padding_line_${i}_${name}_data";`);
				}
			}
			await fs.writeFile(path.join(tmpDir, name), `${lines.join("\n")}\n`);
		}
		const session = createSession();
		const tool = new SearchTool(session);
		const result = await tool.execute("call-seen-test", {
			type: "text",
			input: "SEEN_TEST_TOKEN",
			path: ".",
		});

		const text = extractText(result);
		expect(text).toContain("artifact://");

		// Inspect snapshot store seenLines for first.ts
		const store = getFileSnapshotStore(session);
		const firstAbs = path.join(tmpDir, "first.ts");
		const key = canonicalSnapshotKey(firstAbs);
		const snap = store.head(key);
		expect(snap).not.toBeNull();
		const seenSet = snap?.seenLines;
		expect(seenSet).toBeDefined();

		// Representative matches at lines 5 and 10 should be seen
		expect(seenSet?.has(5)).toBe(true);
		expect(seenSet?.has(10)).toBe(true);

		// Hidden matches at lines 15, 20, 25, 30 must NOT be in seenSet
		expect(seenSet?.has(15)).toBe(false);
		expect(seenSet?.has(20)).toBe(false);
		expect(seenSet?.has(25)).toBe(false);
		expect(seenSet?.has(30)).toBe(false);
	});

	it("falls back to generic behavior when artifact allocation throws an error", async () => {
		for (let i = 1; i <= 4; i++) {
			const lines: string[] = [];
			for (let j = 1; j <= 20; j++) {
				lines.push(`const item_${j} = "FALLBACK_NEEDLE";`);
			}
			await fs.writeFile(path.join(tmpDir, `fallback_${i}.ts`), `${lines.join("\n")}\n`);
		}

		// Artifact allocation throws an error (simulated allocation/write failure)
		const session = createSession({ failArtifacts: true });
		const tool = new SearchTool(session);
		const result = await tool.execute("call-fallback-search", {
			type: "text",
			input: "FALLBACK_NEEDLE",
			path: ".",
		});

		const text = extractText(result);
		// Since artifact allocation failed, it did not compact into an unrecoverable state
		expect(text).not.toContain("artifact://");
		// All files and their full matches are retained under generic head bounds
		for (let i = 1; i <= 4; i++) {
			expect(text).toContain(`fallback_${i}.ts`);
		}
	});

	it("falls back to generic behavior when session has no artifact store", async () => {
		for (let i = 1; i <= 4; i++) {
			const lines: string[] = [];
			for (let j = 1; j <= 20; j++) {
				lines.push(`const item_${j} = "NOSTORE_NEEDLE";`);
			}
			await fs.writeFile(path.join(tmpDir, `nostore_${i}.ts`), `${lines.join("\n")}\n`);
		}

		const session = createSession({ noStore: true });
		const tool = new SearchTool(session);
		const result = await tool.execute("call-nostore-search", {
			type: "text",
			input: "NOSTORE_NEEDLE",
			path: ".",
		});

		const text = extractText(result);
		expect(text).not.toContain("artifact://");
		for (let i = 1; i <= 4; i++) {
			expect(text).toContain(`nostore_${i}.ts`);
		}
	});

	it("leaves explicit single-file and selector scopes unchanged", async () => {
		const lines: string[] = [];
		for (let i = 1; i <= 80; i++) {
			lines.push(`const line_${i} = "SINGLE_SCOPE_NEEDLE_${i}";`);
		}
		const singleFile = path.join(tmpDir, "single.ts");
		await fs.writeFile(singleFile, `${lines.join("\n")}\n`);

		const session = createSession();
		const tool = new SearchTool(session);

		// Explicit single file search
		const singleResult = await tool.execute("call-single", {
			type: "text",
			input: "SINGLE_SCOPE_NEEDLE",
			path: "single.ts",
		});
		const singleText = extractText(singleResult);
		expect(singleText).not.toContain("artifact://");
		for (let i = 1; i <= 80; i++) {
			expect(singleText).toContain(`SINGLE_SCOPE_NEEDLE_${i}`);
		}

		// Explicit selector search
		const selectorResult = await tool.execute("call-selector", {
			type: "text",
			input: "SINGLE_SCOPE_NEEDLE",
			path: "single.ts:1-10",
		});
		const selectorText = extractText(selectorResult);
		expect(selectorText).not.toContain("artifact://");
		for (let i = 1; i <= 10; i++) {
			expect(selectorText).toContain(`SINGLE_SCOPE_NEEDLE_${i}`);
		}
		expect(selectorText).not.toContain("SINGLE_SCOPE_NEEDLE_15");
	});
	it("does not authorize single-file matches omitted by generic head truncation", async () => {
		const singleFile = path.join(tmpDir, "large-single.ts");
		const lines = Array.from(
			{ length: 200 },
			(_, index) => `const value_${index + 1} = "GENERIC_HEAD_NEEDLE_${index + 1}_${"x".repeat(400)}";`,
		);
		await fs.writeFile(singleFile, `${lines.join("\n")}\n`, "utf8");

		const session = createSession();
		const result = await new SearchTool(session).execute("call-generic-head", {
			type: "text",
			input: "GENERIC_HEAD_NEEDLE",
			path: "large-single.ts",
		});
		const text = extractText(result);
		expect(result.details?.type).toBe("text");
		if (result.details?.type !== "text") throw new Error("Expected text search details");
		expect(result.details.result.truncation?.truncated).toBe(true);
		expect(text).toContain("GENERIC_HEAD_NEEDLE_1_");
		expect(text).not.toContain("GENERIC_HEAD_NEEDLE_200_");

		const tag = text.match(/\[large-single\.ts#([0-9A-F]{4})\]/)?.[1];
		expect(tag).toBeDefined();
		if (!tag) throw new Error("Expected hashline snapshot tag");
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(singleFile), tag);
		expect(snapshot?.seenLines?.has(1)).toBe(true);
		expect(snapshot?.seenLines?.has(200)).toBe(false);
	});

	it("returns full output without compaction when broad search output is within discovery budget", async () => {
		// 2 files with 1 tiny match each (well within turn-0 discovery budget of ~2KB)
		await fs.writeFile(path.join(tmpDir, "small_1.ts"), 'const x = "TINY_NEEDLE";\n');
		await fs.writeFile(path.join(tmpDir, "small_2.ts"), 'const y = "TINY_NEEDLE";\n');

		const session = createSession();
		const tool = new SearchTool(session);
		const result = await tool.execute("call-small-broad-search", {
			type: "text",
			input: "TINY_NEEDLE",
			path: ".",
		});

		const text = extractText(result);
		expect(text).not.toContain("artifact://");
		expect(text).toContain("small_1.ts");
		expect(text).toContain("small_2.ts");
		expect(result.details?.type).toBe("text");
		if (result.details?.type !== "text") throw new Error("Expected text search details");
		expect(result.details.result.truncation).toBeUndefined();
	});

	it("bounds warnings and preserves recovery for semicolon lists longer than a filesystem component", async () => {
		for (let fileIndex = 1; fileIndex <= 2; fileIndex++) {
			const lines = Array.from(
				{ length: 20 },
				(_, lineIndex) => `const warning_${fileIndex}_${lineIndex} = "WARNING_CAP_NEEDLE";`,
			);
			await fs.writeFile(path.join(tmpDir, `warning-cap-${fileIndex}.ts`), `${lines.join("\n")}\n`, "utf8");
		}
		const missingPaths = Array.from({ length: 40 }, (_, index) => `missing-${index}-${"x".repeat(80)}.ts`);
		const session = createSession();
		const result = await new SearchTool(session).execute("call-warning-cap", {
			type: "text",
			input: "WARNING_CAP_NEEDLE",
			path: ["warning-cap-1.ts", "warning-cap-2.ts", ...missingPaths].join(";"),
		});

		const text = extractText(result);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(inlineCapForTurn(BROAD_SEARCH_INLINE_MAX_BYTES, 0));
		expect(text).toContain("artifact://");
		expect(result.details?.type).toBe("text");
		if (result.details?.type !== "text") throw new Error("Expected text search details");
		const artifactId = result.details.result.meta?.truncation?.artifactId;
		expect(artifactId).toBeDefined();
		if (!artifactId) throw new Error("Expected artifact id");
		const artifactPath = idToPath.get(artifactId);
		expect(artifactPath).toBeDefined();
		if (!artifactPath) throw new Error("Expected artifact path");
		const fullOutput = await fs.readFile(artifactPath, "utf8");
		expect(fullOutput).toContain("Skipped missing paths:");
		expect(fullOutput).toContain(missingPaths.at(-1)!);
	});

	it("retains warnings and notices in compact broad search", async () => {
		for (let i = 1; i <= 4; i++) {
			const lines: string[] = [];
			for (let j = 1; j <= 20; j++) {
				lines.push(`const k_${j} = "[unclosed_bracket_WARN_NEEDLE";`);
			}
			await fs.writeFile(path.join(tmpDir, `w_${i}.ts`), `${lines.join("\n")}\n`);
		}

		const session = createSession();
		const tool = new SearchTool(session);
		// An uncompilable regex that triggers literal fallback warning
		const result = await tool.execute("call-warn-search", {
			type: "text",
			input: "[unclosed_bracket_WARN_NEEDLE",
			path: ".",
		});

		const text = extractText(result);
		// Warning is retained in the compact output
		expect(text).toContain("searched for it literally instead");
		expect(text).toContain("artifact://");
	});
});
