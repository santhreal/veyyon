/**
 * WHY THIS SUITE EXISTS (PER-DEPTH SUBAGENT MODELS — THE WHOLE CLASS).
 *
 * `subagent.model` is one blanket chain for every subagent, at every depth.
 * `subagent.modelByDepth` maps a spawn depth ("1" for a direct child, "2" for a
 * grandchild, and so on) to a chain of the same shape, so a spawn's DEPTH can
 * decide its model: a strong model for the direct delegate, a cheap one for the
 * grandchildren it fans out.
 *
 * The class this closes is a precedence layer that applies at the wrong moment
 * or disappears quietly:
 *
 *  1. A row must win at EXACTLY its depth and only there. A depth row that also
 *     fired for other depths would make the blanket setting unreachable, and
 *     one that never fired would be a knob wired to nothing.
 *  2. A row that matches no model must REFUSE, naming its own
 *     `subagent.modelByDepth.<n>` row. Falling through to the blanket is the
 *     defect the blanket/frontmatter layers already refuse to commit: a
 *     configured setting that looks live and does nothing.
 *  3. A caller that passes no depth (depth 0, the root session, or a surface
 *     describing an agent rather than a spawn) sees today's behavior exactly,
 *     whatever rows are configured.
 *
 * Every case drives `resolveSubagentModel` — the one owner of "what model does
 * a subagent run" — the way the task executor and the eval agent-bridge call
 * it: with the depth the SPAWNED agent will run at (the parent session's depth
 * plus one).
 *
 * WHAT THIS DOES NOT CATCH: a spawn site that never threads its depth into the
 * resolver. The resolver cannot see a missing argument; the wiring is reviewed
 * per caller, and a depth-unaware caller resolves exactly as it did before this
 * setting existed.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getDefault, getType, getUi } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import { resolveSubagentModel, subagentModelSourceLabel } from "@veyyon/coding-agent/task/subagent-settings";

const AGENT = "reviewer";
const BLANKET = "anthropic/claude-sonnet-4-5";
const FRONTMATTER = "google/gemini-2.5-pro";
const SESSION = "anthropic/claude-opus-4-5";
const DEPTH_ONE = "openai/gpt-5-mini";
const DEPTH_TWO = "openai/gpt-5-nano";

describe("a depth row outranks every existing layer at exactly its own depth", () => {
	/**
	 * The headline case: blanket, frontmatter and session are ALL configured,
	 * and the depth row still decides — because outranking one of them in
	 * isolation says nothing about the others.
	 */
	it("beats the blanket, the frontmatter, and the session model together", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.modelByDepth": { "1": DEPTH_ONE },
		});

		const resolved = resolveSubagentModel({
			settings,
			agentName: AGENT,
			agentModel: FRONTMATTER,
			activeModelPattern: SESSION,
			taskDepth: 1,
		});

		expect(resolved.source).toBe("depth");
		expect(resolved.depth).toBe(1);
		expect(resolved.patterns).toEqual([DEPTH_ONE]);
		expect(resolved.unresolved).toBeUndefined();
	});

	/**
	 * A row is scoped to its own depth or the map is a second blanket wearing a
	 * different name: the "1" row must not leak into a grandchild spawn.
	 */
	it("decides nothing at any other depth", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.modelByDepth": { "1": DEPTH_ONE },
		});

		for (const taskDepth of [2, 3, 10]) {
			const resolved = resolveSubagentModel({ settings, agentName: AGENT, taskDepth });
			expect(resolved.source, `depth ${taskDepth}`).toBe("blanket");
			expect(resolved.patterns, `depth ${taskDepth}`).toEqual([BLANKET]);
		}
	});

	/**
	 * Two rows at once, each landing on its own spawn, so "the first row wins
	 * everywhere" cannot pass as per-depth routing.
	 */
	it("routes each depth to its own row", () => {
		const settings = Settings.isolated({
			"subagent.modelByDepth": { "1": DEPTH_ONE, "2": DEPTH_TWO },
		});

		expect(resolveSubagentModel({ settings, agentName: AGENT, taskDepth: 1 }).patterns).toEqual([DEPTH_ONE]);
		expect(resolveSubagentModel({ settings, agentName: AGENT, taskDepth: 2 }).patterns).toEqual([DEPTH_TWO]);
	});

	/**
	 * Depths without a row keep the old order, in full: blanket, then
	 * frontmatter, then the session. Pinning only "miss → blanket" would leave
	 * the rest of the chain free to rot.
	 */
	it("leaves blanket, frontmatter and inherit in their old order when no row matches", () => {
		const withBlanket = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.modelByDepth": { "2": DEPTH_TWO },
		});
		const withoutBlanket = Settings.isolated({ "subagent.modelByDepth": { "2": DEPTH_TWO } });

		expect(
			resolveSubagentModel({ settings: withBlanket, agentName: AGENT, agentModel: FRONTMATTER, taskDepth: 1 })
				.patterns,
		).toEqual([BLANKET]);
		expect(
			resolveSubagentModel({ settings: withoutBlanket, agentName: AGENT, agentModel: FRONTMATTER, taskDepth: 1 }),
		).toEqual({ patterns: [FRONTMATTER], source: "frontmatter", depth: undefined, unresolved: undefined });
		expect(
			resolveSubagentModel({
				settings: withoutBlanket,
				agentName: AGENT,
				activeModelPattern: SESSION,
				taskDepth: 1,
			}),
		).toEqual({ patterns: [SESSION], source: "inherit", depth: undefined, unresolved: undefined });
	});

	/**
	 * A row holds a CHAIN, the same value shape as `subagent.model`, and both
	 * spellings reach the resolver through the same normalization: the picker
	 * writes a list, a hand-edited config writes a comma string.
	 */
	it("carries an ordered chain, written as a list or a comma string", () => {
		const asList = Settings.isolated({ "subagent.modelByDepth": { "1": [DEPTH_ONE, BLANKET] } });
		const asString = Settings.isolated({ "subagent.modelByDepth": { "1": `${DEPTH_ONE}, ${BLANKET}` } });

		for (const settings of [asList, asString]) {
			const resolved = resolveSubagentModel({ settings, agentName: AGENT, taskDepth: 1 });
			expect(resolved.source).toBe("depth");
			expect(resolved.patterns).toEqual([DEPTH_ONE, BLANKET]);
		}
	});
});

describe("a depth row that matches no model refuses, naming its own row", () => {
	/**
	 * The same contract the blanket and frontmatter layers already keep: a
	 * configured value that expands to nothing comes back `unresolved` so the
	 * spawn is refused and the setting named, rather than silently dropping to
	 * the next layer. Here the blanket IS configured, so a fallthrough would
	 * have something to fall to — which is exactly what must not happen.
	 */
	it("does not fall through to the blanket", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.modelByDepth": { "2": "@no-such-role" },
		});

		const resolved = resolveSubagentModel({ settings, agentName: AGENT, taskDepth: 2 });

		expect(resolved.patterns).toEqual([]);
		expect(resolved.source).toBe("depth");
		expect(resolved.unresolved).toEqual({ source: "depth", value: "@no-such-role", depth: 2 });
	});

	/**
	 * The refusal message and the resolved-model badge both take their wording
	 * from `subagentModelSourceLabel`, so the row the operator must edit is the
	 * row the label names.
	 */
	it("names subagent.modelByDepth.<n> as the deciding setting", () => {
		const settings = Settings.isolated({ "subagent.modelByDepth": { "2": "@no-such-role" } });
		const resolved = resolveSubagentModel({ settings, agentName: AGENT, taskDepth: 2 });

		expect(subagentModelSourceLabel(resolved.source, AGENT, resolved.unresolved?.depth)).toBe(
			"subagent.modelByDepth.2",
		);
	});
});

describe("a caller with no depth keeps today's behavior", () => {
	/**
	 * Depth 0 is the root session and an omitted depth is a surface describing
	 * an agent rather than a spawn (the Agents table). Both must resolve
	 * exactly as if the map did not exist, even with rows configured — a depth
	 * row that reached the root would re-decide the SESSION's own delegates
	 * behind the blanket's back.
	 */
	it("ignores every row at depth 0 and at no depth at all", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.modelByDepth": { "1": DEPTH_ONE },
		});

		for (const taskDepth of [undefined, 0]) {
			const resolved = resolveSubagentModel({
				settings,
				agentName: AGENT,
				agentModel: FRONTMATTER,
				activeModelPattern: SESSION,
				taskDepth,
			});
			expect(resolved.source, `taskDepth ${String(taskDepth)}`).toBe("blanket");
			expect(resolved.patterns, `taskDepth ${String(taskDepth)}`).toEqual([BLANKET]);
			expect(resolved.depth, `taskDepth ${String(taskDepth)}`).toBeUndefined();
		}
	});

	/**
	 * An empty map is the unset state: the UI leaves one behind when its last
	 * row is cleared, and it must not change a single answer.
	 */
	it("treats an empty map as no map at all", () => {
		const settings = Settings.isolated({ "subagent.modelByDepth": {} });

		expect(resolveSubagentModel({ settings, agentName: AGENT, taskDepth: 1, activeModelPattern: SESSION })).toEqual(
			{ patterns: [SESSION], source: "inherit", depth: undefined, unresolved: undefined },
		);
	});
});

describe("the source label", () => {
	/**
	 * Every layer names the setting an operator can go and change, so a spawn
	 * refusal is actionable. The depth variant names the exact row, not the
	 * whole map.
	 */
	it("names the deciding row for every layer", () => {
		expect(subagentModelSourceLabel("depth", AGENT, 3)).toBe("subagent.modelByDepth.3");
		expect(subagentModelSourceLabel("blanket", AGENT)).toBe("subagent.model");
		expect(subagentModelSourceLabel("frontmatter", AGENT)).toContain("frontmatter");
		expect(subagentModelSourceLabel("inherit", AGENT)).toContain("session");
	});
});

describe("the settings domain declaration", () => {
	/**
	 * The map is declared where every other `subagent.*` setting is declared,
	 * with a UI row in the Models section of the Subagents tab. Pinning the
	 * declaration itself keeps the rest of the suite from passing against a
	 * schema that quietly lost the key.
	 */
	it("is a record in the Models group of the Subagents tab, defaulting to no rows", () => {
		expect(getType("subagent.modelByDepth")).toBe("record");
		expect(getDefault("subagent.modelByDepth")).toEqual({});
		const ui = getUi("subagent.modelByDepth");
		expect(ui?.tab).toBe("subagents");
		expect(ui?.group).toBe("Models");
		expect(ui?.label).toBe("Models by Depth");
	});

	/**
	 * A record with no dedicated UI type falls through to the generic
	 * record-as-text control, which would ask the operator to type JSON. The
	 * depth rows edit through the same chain picker as `subagent.model`, so pin
	 * the type, not just the presence.
	 */
	it("renders as the per-depth chain editor, never the generic text control", () => {
		const def = getSettingsForTab("subagents").find(entry => entry.path === "subagent.modelByDepth");

		expect(def?.type).toBe("subagentModelByDepth");
		expect(def?.group).toBe("Models");
	});
});
