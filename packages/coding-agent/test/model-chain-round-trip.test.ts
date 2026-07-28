/**
 * Contract: one encoding for a model chain, read the same way by every consumer.
 *
 * `compaction.model` and `subagent.model` both hold an ORDERED chain. The
 * settings picker persists it as a comma-separated string; compaction and the
 * subagent spawner each read it back through `normalizeModelPatternList`. If
 * those two ever disagree, the picker shows a chain the runtime does not run,
 * which is the worst kind of settings bug: it looks configured and does nothing.
 *
 * These are value-level tests on the one splitter and the two readers, not on
 * the TUI, because the splitter is where the encoding is actually decided.
 */
import { describe, expect, it } from "bun:test";
import { normalizeModelPatternList, resolveCompactionModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveSubagentModel } from "@veyyon/coding-agent/task/subagent-settings";

describe("model chain encoding", () => {
	/**
	 * The picker writes `"a,b,c"`. Anything that reads the setting must get back
	 * exactly three entries in exactly that order, because order IS the feature:
	 * entry one is the choice and the rest are ranked fallbacks.
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
	 * Precedence is unchanged by chains: a per-agent row still replaces the
	 * blanket list wholesale rather than appending to it. Merging the two would
	 * mean an agent you pinned to one model could still run on the blanket
	 * fallbacks, which is not what pinning means.
	 */
	it("a per-agent chain replaces the blanket chain rather than extending it", () => {
		const settings = Settings.isolated({
			"subagent.model": "anthropic/opus,anthropic/sonnet",
			"subagent.agents": { reviewer: { model: "openai/gpt-5" } },
		} as Parameters<typeof Settings.isolated>[0]);
		const resolved = resolveSubagentModel({ settings, agentName: "reviewer", agentModel: undefined });
		expect(resolved.source).toBe("agent");
		expect(resolved.patterns).toEqual(["openai/gpt-5"]);
	});
});
