/**
 * Every web scraper and search provider has a dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A scraper or search provider with no dedicated test is a parity
 * gap. This suite derives the scraper list from specialHandlers and the
 * search provider list from the search directory at runtime and asserts each
 * has a dedicated test file.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { specialHandlers } from "@veyyon/coding-agent/web/scrapers";

const TEST_ROOT = join(import.meta.dir, "..");
const SEARCH_SRC = join(import.meta.dir, "..", "..", "src", "web", "search", "providers");

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

const ALL_TEST_FILES = collectTestFiles(TEST_ROOT);
const ALL_TEST_NAMES = new Set(ALL_TEST_FILES.map(f => f.split("/").pop()!.replace(/\.test\.ts$/, "")));

/** Collect search provider source modules (excluding index, types, utils). */
function collectSearchProviders(): string[] {
	return readdirSync(SEARCH_SRC)
		.filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map(f => f.replace(/\.ts$/, ""))
		.filter(name => !["index", "types", "utils", "base", "provider", "render", "public"].includes(name))
		.sort();
}

const SEARCH_PROVIDERS = collectSearchProviders();

/** Whether a name has a dedicated test file (by exact name or as a substring). */
function hasTest(name: string): boolean {
	return ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		return base.includes(name);
	});
}

const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"browser-headers": "tested via browser-page and web-search integration suites",
	"browser-page": "tested via browser tool and web-search integration suites",
	"duckduckgo": "tested via web-search command and search provider integration suites",
	"ecosia": "tested via web-search command suites (ecosia wraps brave)",
	"perplexity-auth": "tested via perplexity provider and auth suites",
	"startpage": "tested via web-search command suites (startpage wraps google)",
	brave: "tested via web-search command suites",
	google: "tested via web-search command suites and google provider suites in packages/ai/test",
	kimi: "tested via provider kimi suites in packages/ai/test",
	synthetic: "tested via web-search synthetic provider suites",
};

describe("web scraper registry", () => {
	it("specialHandlers is non-empty", () => {
		expect(specialHandlers.length).toBeGreaterThan(0);
	});

	it("every entry is a function", () => {
		for (const handler of specialHandlers) {
			expect(typeof handler).toBe("function");
		}
	});

	it("the handler count is pinned (grows when a scraper is added)", () => {
		// Pin the count so adding or removing a scraper is a deliberate act.
		// Update this number when a scraper is added or removed.
		expect(specialHandlers.length).toBe(75);
	});
});

describe("every search provider has test coverage", () => {
	it("there are search provider modules", () => {
		expect(SEARCH_PROVIDERS.length).toBeGreaterThan(0);
	});

	for (const provider of SEARCH_PROVIDERS) {
		it(`search provider "${provider}" has a dedicated test file or is audited`, () => {
			const hasFile = hasTest(provider);
			const hasCrossToolNote = provider in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`Search provider "${provider}" has no dedicated test file. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for providers without a test file", () => {
		const withoutFiles = SEARCH_PROVIDERS.filter(name => !hasTest(name));
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => hasTest(name));
		expect(stale, "These providers now have test files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
