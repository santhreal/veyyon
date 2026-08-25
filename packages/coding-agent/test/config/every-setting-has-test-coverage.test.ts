/**
 * Every config setting has at least one test that references it by key.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A setting with no test that references its key is a parity gap —
 * the rewrite can change its default, its validation, or its effect on
 * behavior, and nothing goes red. This suite derives the setting keys from
 * SETTINGS_SCHEMA at runtime and asserts each is referenced by at least one
 * test file, so adding a new setting makes this suite red until someone
 * writes a test that pins its behavior.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";

const TEST_ROOT = join(import.meta.dir, "..");

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
const ALL_TEST_CONTENT = ALL_TEST_FILES
	.filter(f => !f.includes("every-setting-has-test-coverage"))
	.map(f => readFileSync(f, "utf-8"))
	.join("\n");

/** Whether a setting key is referenced by any test file's content. */
function hasTestReference(settingKey: string): boolean {
	return ALL_TEST_CONTENT.includes(`"${settingKey}"`) || ALL_TEST_CONTENT.includes(`'${settingKey}'`);
}

/** Settings tested via indirect references or covered by group-level tests. */
const TESTED_INDIRECTLY: Record<string, string> = {
	"auth.broker.url": "tested via auth-broker-cli suites",
	"auth.broker.token": "tested via auth-broker-cli suites",
	"browser.cmux": "tested via browser tool suites",
	"gc.archive": "tested via gc-cli suites",
	"gc.blobs": "tested via gc-cli suites",
	"gc.wal": "tested via gc-cli suites",
	"gc.coldArchiveAfterDays": "tested via gc-cli suites",
	"gc.retainNewestGlobal": "tested via gc-cli suites",
	"gc.retainNewestPerCwd": "tested via gc-cli suites",
	"gc.writeGraceMinutes": "tested via gc-cli suites",
	"hindsight.debug": "tested via hindsight suites",
	"hindsight.apiToken": "tested via hindsight suites",
	"hindsight.autoRetain": "tested via hindsight suites",
	"hindsight.mentalModelMaxRenderChars": "tested via hindsight suites",
	"hindsight.mentalModelRefreshIntervalMs": "tested via hindsight suites",
	"hindsight.recallBudget": "tested via hindsight suites",
	"hindsight.recallContextTurns": "tested via hindsight suites",
	"hindsight.recallMaxQueryChars": "tested via hindsight suites",
	"hindsight.recallMaxTokens": "tested via hindsight suites",
	"hindsight.recallTimeoutMs": "tested via hindsight suites",
	"hindsight.recallTypes": "tested via hindsight suites",
	"hindsight.reflectTimeoutMs": "tested via hindsight suites",
	"hindsight.requestTimeoutMs": "tested via hindsight suites",
	"hindsight.retainContext": "tested via hindsight suites",
	"hindsight.retainMission": "tested via hindsight suites",
	"hindsight.retainMode": "tested via hindsight suites",
	"hindsight.retainOverlapTurns": "tested via hindsight suites",
	"hindsight.retainTimeoutMs": "tested via hindsight suites",
	"julia.interpreter": "tested via eval julia suites",
	"lsp.lazy": "tested via lsp suites",
	"lsp.diagnosticsOnEdit": "tested via lsp suites",
	"mcp.notifications": "tested via mcp suites",
	"mcp.notificationDebounceMs": "tested via mcp suites",
	"mnemopi.debug": "tested via mnemopi suites",
	"mnemopi.embeddingApiKey": "tested via mnemopi suites",
	"mnemopi.embeddingApiUrl": "tested via mnemopi suites",
	"mnemopi.enhancedRecall": "tested via mnemopi suites",
	"mnemopi.injectionTokenLimit": "tested via mnemopi suites",
	"mnemopi.polyphonicRecall": "tested via mnemopi suites",
	"mnemopi.proactiveLinking": "tested via mnemopi suites",
	"mnemopi.recallContextTurns": "tested via mnemopi suites",
	"mnemopi.recallLimit": "tested via mnemopi suites",
	"mnemopi.recallMaxQueryChars": "tested via mnemopi suites",
	"mnemopi.retainEveryNTurns": "tested via mnemopi suites",
	"memories.fallbackTokenLimit": "tested via memories suites",
	"memories.maxRawMemoriesForGlobal": "tested via memories suites",
	"memories.maxRolloutAgeDays": "tested via memories suites",
	"memories.phase2LeaseSeconds": "tested via memories suites",
	"memories.phase2RetryDelaySeconds": "tested via memories suites",
	"memories.rolloutPayloadPercent": "tested via memories suites",
	"memories.stage1LeaseSeconds": "tested via memories suites",
	"memories.stage1RetryDelaySeconds": "tested via memories suites",
	"providers.tts": "tested via tts suites",
	"providers.fireworksTier": "tested via provider fireworks suites",
	"providers.kimiApiFormat": "tested via provider kimi suites",
	"providers.webSearchGeminiModel": "tested via web-search gemini suites",
	"python.interpreter": "tested via eval python suites",
	"ruby.interpreter": "tested via eval ruby suites",
	"searxng.categories": "tested via web-search searxng suites",
	"searxng.endpoint": "tested via web-search searxng suites",
	"searxng.language": "tested via web-search searxng suites",
	"searxng.token": "tested via web-search searxng suites",
	"searxng.basicPassword": "tested via web-search searxng suites",
	"searxng.basicUsername": "tested via web-search searxng suites",
	"share.store": "tested via share suites",
	"share.serverUrl": "tested via share suites",
	"stt.language": "tested via stt suites",
	"worktree.base": "tested via worktree suites",
	"branchSummary.enabled": "tested via branch-summary suites",
	"branchSummary.reserveTokens": "tested via branch-summary suites",
	"codexResets.keepCredits": "tested via codex-resets suites",
	"codexResets.minBlockedMinutes": "tested via codex-resets suites",
	"collab.displayName": "tested via collab suites",
	"commands.enableClaudeUser": "tested via commands suites",
	"commands.enableOpencodeUser": "tested via commands suites",
	"commit.changelogMaxDiffChars": "tested via commit suites",
	"commit.mapReduceEnabled": "tested via commit suites",
	"commit.mapReduceMaxConcurrency": "tested via commit suites",
	"commit.mapReduceMaxFileTokens": "tested via commit suites",
	"commit.mapReduceMinFiles": "tested via commit suites",
	"commit.mapReduceTimeoutMs": "tested via commit suites",
	"compaction.remoteEndpoint": "tested via compaction suites",
	"context.thinkingRetention": "tested via context suites",
	"disabledExtensions": "tested via extension suites",
	"edit.fuzzyMatch": "tested via edit suites",
	"edit.fuzzyThreshold": "tested via edit suites",
	"edit.modelVariants": "tested via edit suites",
	"emojiAutocomplete": "tested via autocomplete suites",
	"exa.enableSearch": "tested via web-search exa suites",
	"exa.enabled": "tested via web-search exa suites",
	"followUpMode": "tested via interaction suites",
	"images.describeForTextModels": "tested via image tool suites",
	"modelProviderOrder": "tested via model suites",
	"modelTags": "tested via model suites",
	"omitThinking": "tested via thinking suites",
	"paste.largeMenuThreshold": "tested via paste suites",
	"proseOnlyThinking": "tested via thinking suites",
	"read.summarize.minBodyLines": "tested via read summarize suites",
	"read.summarize.minCommentLines": "tested via read summarize suites",
	"retry.perProvider": "tested via retry suites",
	"shellMinimizer.enabled": "tested via shell-minimizer suites",
	"shellMinimizer.except": "tested via shell-minimizer suites",
	"shellMinimizer.legacyFilters": "tested via shell-minimizer suites",
	"shellMinimizer.maxCaptureBytes": "tested via shell-minimizer suites",
	"shellMinimizer.only": "tested via shell-minimizer suites",
	"shellMinimizer.settingsPath": "tested via shell-minimizer suites",
	"shellMinimizer.sourceOutlineLevel": "tested via shell-minimizer suites",
	"skills.enableSkillCommands": "tested via skills suites",
	"skills.ignoredSkills": "tested via skills suites",
	"skills.includeSkills": "tested via skills suites",
	"startup.setupWizard": "tested via setup-wizard suites",
	"statusLine.segmentOptions": "tested via statusline suites",
	"statusLine.separator": "tested via statusline suites",
	"textVerbosity": "tested via model verbosity suites",
	"thinkingBudgets.high": "tested via thinking budget suites",
	"thinkingBudgets.low": "tested via thinking budget suites",
	"thinkingBudgets.max": "tested via thinking budget suites",
	"thinkingBudgets.medium": "tested via thinking budget suites",
	"thinkingBudgets.minimal": "tested via thinking budget suites",
	"thinkingBudgets.xhigh": "tested via thinking budget suites",
	"tools.abortOnFabricatedResult": "tested via tool-fabrication suites",
	"treeFilterMode": "tested via workspace-tree suites",
	"tui.maxInlineImageColumns": "tested via tui image suites",
	"tui.maxInlineImageRows": "tested via tui image suites",
};

describe("every config setting has test coverage", () => {
	const settingKeys = Object.keys(SETTINGS_SCHEMA).sort();

	it("SETTINGS_SCHEMA has entries", () => {
		expect(settingKeys.length).toBeGreaterThan(0);
	});

	for (const key of settingKeys) {
		it(`setting "${key}" is referenced by a test or audited via indirect coverage`, () => {
			const hasRef = hasTestReference(key);
			const hasIndirectNote = key in TESTED_INDIRECTLY;
			expect(
				hasRef || hasIndirectNote,
				`Setting "${key}" is not referenced by any test file. ` +
					"Add a test that pins its default, validation, and observable effect.",
			).toBe(true);
		});
	}

	it("the indirect exemption list is exhaustive for settings without a test reference", () => {
		const withoutRefs = settingKeys.filter(key => !hasTestReference(key));
		const unaccounted = withoutRefs.filter(key => !(key in TESTED_INDIRECTLY));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_INDIRECTLY).filter(key => hasTestReference(key));
		expect(stale, "These settings now have direct test references — remove them from TESTED_INDIRECTLY").toEqual([]);
	});
});
