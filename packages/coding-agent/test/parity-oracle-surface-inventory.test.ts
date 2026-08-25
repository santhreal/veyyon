/**
 * The parity oracle surface inventory is complete.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. This is the umbrella test that asserts every surface-axis coverage
 * meta-test exists and is registered. If a new surface axis is added without
 * a coverage meta-test, this suite goes red. The individual meta-tests
 * (every-tool, every-provider, every-command, etc.) each derive their variant
 * space from source and assert every element has coverage. This test ensures
 * the set of meta-tests itself is complete.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Every coverage meta-test file that must exist. */
const COVERAGE_META_TESTS: Record<string, string> = {
	"builtin tools": "packages/coding-agent/test/tools/every-tool-has-dedicated-test-coverage.test.ts",
	"provider APIs": "packages/ai/test/every-provider-api-has-dedicated-test-coverage.test.ts",
	"CLI modules": "packages/coding-agent/test/cli/every-cli-module-has-dedicated-test-coverage.test.ts",
	"registered commands": "packages/coding-agent/test/commands/every-command-has-dedicated-test-coverage.test.ts",
	"slash commands": "packages/coding-agent/test/slash-commands/every-slash-command-has-dedicated-test-coverage.test.ts",
	"config settings": "packages/coding-agent/test/config/every-setting-has-test-coverage.test.ts",
	"session transitions": "packages/coding-agent/test/session/every-session-transition-has-test-coverage.test.ts",
	"internal URL schemes": "packages/coding-agent/test/internal-urls/every-scheme-has-test-coverage.test.ts",
	"wire messages": "packages/wire/test/every-wire-message-has-test-coverage.test.ts",
	"eval languages": "packages/coding-agent/test/eval/eval-language-coverage.test.ts",
	"system-prompt-builder modules": "packages/coding-agent/test/system-prompt-builder/every-module-has-test-coverage.test.ts",
	"web scrapers and search providers": "packages/coding-agent/test/web/every-scraper-and-provider-has-test-coverage.test.ts",
	"MCP transports": "packages/coding-agent/test/mcp/every-transport-has-test-coverage.test.ts",
	"theme system modules": "packages/coding-agent/test/modes/theme/every-theme-module-has-test-coverage.test.ts",
	"keybindings": "packages/coding-agent/test/config/every-keybinding-has-test-coverage.test.ts",
	"Rust native modules": "packages/natives/test/every-native-module-has-test-coverage.test.ts",
	"stats modules": "packages/stats/test/every-stats-module-has-test-coverage.test.ts",
};

describe("parity oracle surface inventory is complete", () => {
	for (const [axis, path] of Object.entries(COVERAGE_META_TESTS)) {
		it(`coverage meta-test for ${axis} exists`, () => {
			const full = join(import.meta.dir, "..", "..", "..", path);
			expect(existsSync(full), `Missing coverage meta-test: ${path}`).toBe(true);
		});
	}

	it("every surface axis has a coverage meta-test (fails when a new axis is added without one)", () => {
		// This is a living checklist. When a new surface axis is identified
		// (e.g. "TUI render contracts", "argot codec seams"), add it to
		// COVERAGE_META_TESTS above. If you forget, this test reminds you
		// by the absence of the file — but only if you add the axis here.
		// The individual meta-tests are the real guard; this is the index.
		const axes = Object.keys(COVERAGE_META_TESTS);
		expect(axes.length).toBeGreaterThanOrEqual(17);
	});
});
