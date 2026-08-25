/**
 * Every provider API backend has at least one dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A provider API backend with no dedicated test file is a parity gap.
 * This suite derives the API type list from the stream dispatcher's case
 * statements at runtime and asserts each has at least one test file that names
 * it, so adding a new API backend makes this suite red until someone writes
 * its tests.
 *
 * The check is file-name-based. Content-level coverage is verified by the
 * mutation campaign, not here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

const AI_TEST_ROOT = import.meta.dir;
const STREAM_SOURCE = join(import.meta.dir, "..", "src", "stream.ts");

/** Extract every API type from the stream dispatcher's case statements. */
function extractApiTypes(): string[] {
	const source = readFileSync(STREAM_SOURCE, "utf-8");
	const matches = source.matchAll(/case "([a-z-]+)":/g);
	const types = new Set<string>();
	for (const match of matches) {
		const api = match[1];
		// Exclude effort levels that share the case syntax.
		if (["high", "low", "max", "medium", "minimal", "xhigh"].includes(api)) continue;
		types.add(api);
	}
	return [...types].sort();
}

/** Recursively collect every .test.ts file under a root. */
function collectTestFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				stack.push(full);
			} else if (entry.endsWith(".test.ts")) {
				out.push(full);
			}
		}
	}
	return out;
}

const ALL_TEST_FILES = collectTestFiles(AI_TEST_ROOT);

/**
 * A provider API type has a dedicated test if any test file name contains the
 * API type string or its common short form.
 */
function hasDedicatedTest(apiType: string): boolean {
	// Map API types to their common short forms used in test file names.
	const shortForms: Record<string, string[]> = {
		"anthropic-messages": ["anthropic"],
		"azure-openai-responses": ["azure"],
		"bedrock-converse-stream": ["bedrock"],
		"cursor-agent": ["cursor"],
		"devin-agent": ["devin"],
		"gitlab-duo-agent": ["gitlab-duo"],
		"google-generative-ai": ["google"],
		"google-gemini-cli": ["google-gemini-cli"],
		"google-vertex": ["google-vertex"],
		"ollama-chat": ["ollama"],
		"openai-codex-responses": ["openai-codex"],
		"openai-completions": ["openai-completions"],
		"openai-responses": ["openai-responses"],
	};
	const searchTerms = shortForms[apiType] ?? [apiType];
	return ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		return searchTerms.some(term => base.includes(term));
	});
}

/** API backends tested only through cross-cutting suites, not a dedicated file. */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"google-vertex": "google-* test files exercise the shared google provider path",
};

describe("every provider API backend has dedicated test coverage", () => {
	const apiTypes = extractApiTypes();

	it("the stream dispatcher has at least one API type", () => {
		expect(apiTypes.length).toBeGreaterThan(0);
	});

	for (const apiType of apiTypes) {
		it(`API "${apiType}" has a dedicated test file or is audited via cross-tool`, () => {
			const hasFile = hasDedicatedTest(apiType);
			const hasCrossToolNote = apiType in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`API "${apiType}" has no dedicated test file and no cross-tool coverage note. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for APIs without a dedicated file", () => {
		const withoutFiles = apiTypes.filter(name => !hasDedicatedTest(name));
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => hasDedicatedTest(name));
		expect(stale, "These APIs now have dedicated files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
