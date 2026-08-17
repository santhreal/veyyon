/**
 * Contract: one encoding for a model chain, read the same way by every consumer.
 *
 * The settings picker persists it as a string array; legacy configs may still
 * hold a comma-separated string. Compaction and the subagent spawner read both
 * through `normalizeModelPatternList`. If those two ever disagree, the picker
 * shows a chain the runtime does not run,
 * which is the worst kind of settings bug: it looks configured and does nothing.
 *
 * These are value-level tests on the one splitter and the two readers, not on
 * the TUI, because the splitter is where the encoding is actually decided.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeModelPatternList, resolveCompactionModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { SubagentAgentSettings } from "@veyyon/coding-agent/config/settings-domains/subagents";
import { resolveSubagentModel } from "@veyyon/coding-agent/task/subagent-settings";
import { TempDir } from "@veyyon/utils";
import { YAML } from "bun";

describe("model chain encoding", () => {
	/**
	 * A legacy comma string must still read as exactly three entries in exactly
	 * that order, because order IS the feature: entry one is the choice and the
	 * rest are ranked fallbacks.
	 */
	it("splits a comma-separated chain into ordered entries", () => {
		expect(normalizeModelPatternList("anthropic/opus,anthropic/sonnet,anthropic/haiku")).toEqual([
			"anthropic/opus",
			"anthropic/sonnet",
			"anthropic/haiku",
		]);
	});

	/**
	 * A hand-written config may use a YAML list instead. Both spellings are the
	 * same chain, so both must produce the identical array: a user who writes a
	 * list must not silently get different behavior from one who writes a string.
	 */
	it("treats a list and a comma-separated string as the same chain", () => {
		const fromString = normalizeModelPatternList("anthropic/opus,anthropic/sonnet");
		const fromList = normalizeModelPatternList(["anthropic/opus", "anthropic/sonnet"]);
		expect(fromString).toEqual(fromList);
		expect(fromList).toEqual(["anthropic/opus", "anthropic/sonnet"]);
	});

	/**
	 * Whitespace around a comma is what a human types. Keeping it would make
	 * `" anthropic/sonnet"` match no model at all, which surfaces as "your
	 * fallback does nothing" with no hint that a space caused it.
	 */
	it("trims each entry and drops empty ones", () => {
		expect(normalizeModelPatternList(" anthropic/opus , , anthropic/sonnet ,")).toEqual([
			"anthropic/opus",
			"anthropic/sonnet",
		]);
	});

	/**
	 * Unset means inherit, which is an EMPTY chain rather than a chain holding
	 * one empty pattern. A one-entry chain of `""` would match no model and turn
	 * inherit into a hard failure.
	 */
	it("reads an unset value as no chain at all", () => {
		expect(normalizeModelPatternList(undefined)).toEqual([]);
		expect(normalizeModelPatternList("")).toEqual([]);
		expect(normalizeModelPatternList([])).toEqual([]);
	});

	/**
	 * The compaction reader used to call `.trim()` on the raw value, so a config
	 * holding a list crashed with a TypeError from inside compaction rather than
	 * doing anything a user could act on. Both shapes resolve now.
	 */
	it("resolveCompactionModelPatterns accepts both encodings", () => {
		const fromString = Settings.isolated({ "compaction.model": "anthropic/opus,anthropic/sonnet" });
		const fromList = Settings.isolated({
			"compaction.model": ["anthropic/opus", "anthropic/sonnet"],
		} as Parameters<typeof Settings.isolated>[0]);
		expect(resolveCompactionModelPatterns(fromString)).toEqual(["anthropic/opus", "anthropic/sonnet"]);
		expect(resolveCompactionModelPatterns(fromList)).toEqual(["anthropic/opus", "anthropic/sonnet"]);
	});

	/**
	 * The subagent side keeps the whole chain too. The Agents column reads
	 * `patterns.length` to say "+2 fallbacks", and the executor slices everything
	 * after the selected entry into the retry role, so a truncated list here
	 * silently removes every fallback the user configured.
	 */
	it("resolveSubagentModel keeps the whole blanket chain, in order", () => {
		const settings = Settings.isolated({ "subagent.model": "anthropic/opus,anthropic/sonnet,anthropic/haiku" });
		const resolved = resolveSubagentModel({ settings, agentName: "reviewer", agentModel: undefined });
		expect(resolved.source).toBe("blanket");
		expect(resolved.patterns).toEqual(["anthropic/opus", "anthropic/sonnet", "anthropic/haiku"]);
	});

	/**
	 * A per-agent lane row is the most specific statement anyone can make — it
	 * names the agent — so a lane that names a model REPLACES the blanket chain
	 * and reports `source: "lane"`, which is what the Agents column badges. The
	 * field was retired once for outranking the blanket setting from a screen
	 * that did not show it, and reinstated when every page that shows a lane's
	 * model became the page that edits it. This asserts the layer that decided is
	 * named, so a silent replacement can never come back.
	 */
	it("lets a per-agent lane row outrank the blanket chain, and names the layer that decided", () => {
		const lane: SubagentAgentSettings = { model: ["openai/gpt-5", "openai/gpt-5-mini"] };
		const settings = Settings.isolated({
			"subagent.model": "anthropic/opus,anthropic/sonnet",
			"subagent.agents": { reviewer: lane },
		});
		const resolved = resolveSubagentModel({ settings, agentName: "reviewer", agentModel: undefined });
		expect(resolved.source).toBe("lane");
		// The lane keeps its own whole chain, in order: truncating here would strip
		// the fallbacks the caller configured, just as truncating the blanket did.
		expect(resolved.patterns).toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);
	});

	/**
	 * The failure this suite exists to catch: a leftover row quietly stripping
	 * every fallback. A row that names NO model must not touch the chain, so a
	 * row carrying only `enabled` — or only the superseded `maxNestedSpawnDepth`
	 * an older release wrote — resolves exactly as if the table were empty.
	 */
	it("keeps the blanket chain whole under a per-agent row that names no model", () => {
		const row: SubagentAgentSettings = { enabled: true, maxNestedSpawnDepth: 0 };
		const settings = Settings.isolated({
			"subagent.model": "anthropic/opus,anthropic/sonnet",
			"subagent.agents": { reviewer: row },
		});
		const resolved = resolveSubagentModel({ settings, agentName: "reviewer", agentModel: undefined });
		expect(resolved.source).toBe("blanket");
		expect(resolved.patterns).toEqual(["anthropic/opus", "anthropic/sonnet"]);
	});
});

describe("compaction model preference persistence", () => {
	/**
	 * `Settings.init` hands back the process-wide instance, so a suite that ran earlier in the same
	 * process and initialized it against ITS OWN agent directory leaves this one writing there: the
	 * `flush` below lands in the other directory and the `config.yml` this test reads never exists.
	 * That is not hypothetical, it is what this test did after any session-initializing suite in the
	 * same batch, while passing perfectly on its own.
	 */
	beforeEach(() => {
		resetSettingsForTest();
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("preserves the selected ordered list and fallback policy across save and reload", async () => {
		const tempDir = TempDir.createSync("@veyyon-compaction-model-roundtrip-");
		try {
			const agentDir = tempDir.join("agent");
			const cwd = tempDir.join("project");
			await mkdir(agentDir, { recursive: true });
			await mkdir(cwd, { recursive: true });

			const selected = ["anthropic/claude-opus:high", "openai/gpt-5:medium", "google/gemini-pro:low"];
			const first = await Settings.init({ cwd, agentDir });
			first.set("compaction.model", selected);
			first.set("compaction.modelFallbackStrategy", "configured-only");
			await first.flush();

			const persisted = YAML.parse(await Bun.file(join(agentDir, "config.yml")).text());
			expect(persisted).toEqual({
				compaction: {
					model: selected,
					modelFallbackStrategy: "configured-only",
				},
			});

			const reloaded = await Settings.init({ cwd, agentDir });
			expect(reloaded.get("compaction.model")).toEqual(selected);
			expect(reloaded.get("compaction.modelFallbackStrategy")).toBe("configured-only");
		} finally {
			await tempDir.remove();
		}
	});
});
