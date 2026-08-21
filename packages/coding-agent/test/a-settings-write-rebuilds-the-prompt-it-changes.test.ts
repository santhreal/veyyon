/**
 * Writing a setting the model's prompt depends on rebuilds that prompt, whoever writes it.
 *
 * WHY THIS SUITE EXISTS. "Which settings rewrite the prompt" had two owners that had to agree
 * and that nothing compared. `system-prompt-builder/gate-registry.ts` holds the rows, and the
 * settings selector asked it — so a flip through the settings UI worked. `AgentSession` held a
 * SECOND list of eight paths and drove the same rebuild off the settings store, which is the
 * only trigger a write from anywhere else can reach: a slash command, an SDK or ACP host, a
 * plugin, `/browser`, a keybinding. Five paths were in both lists, three were in the session's
 * alone, and six live registry gates were in neither — `personality`, `tools.format`,
 * `inlineToolDescriptors`, `includeModelInPrompt`, `tui.renderMermaid` and
 * `tools.intentTracing`. Writing one of those outside the settings screen changed the
 * configuration and left the model reading a prompt that described the previous one, and a UI
 * flip of one of the five rebuilt twice for one change.
 *
 * The class this closes is "the trigger lives next to one writer". The trigger now lives with
 * the prompt, in the session's effective-setting listener, and this suite drives real
 * `Settings` writes at a real `AgentSession` — not the controller, which is only one of the
 * writers, and not the predicate, which is not a contract anyone outside this file can see.
 *
 * Fail-by-default: the sweeps enumerate `LIVE_PROMPT_GATE_SETTINGS` and
 * `TOOL_SHAPE_SETTING_PATHS` at run time, so a new registry row or a new tool-shape path is
 * covered the moment it is declared, and a row that names a path the schema does not have
 * fails here rather than becoming a permanently dead gate.
 *
 * WHAT IT DOES NOT CATCH. It proves the write reaches a rebuild; it does not prove the rebuilt
 * text differs, which is the template's contract and is pinned by the statement and section
 * registries. It also cannot see a writer that bypasses `Settings` entirely and mutates config
 * on disk behind the running session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import { getEnumValues, getType, SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { AgentSession, TOOL_SHAPE_SETTING_PATHS } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import {
	FROZEN_PROMPT_GATE_SETTINGS,
	LIVE_PROMPT_GATE_SETTINGS,
	PROMPT_GATE_SETTINGS,
} from "@veyyon/coding-agent/system-prompt-builder/gate-registry";
import { type } from "arktype";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const TOOL_SHAPE_PATHS = Object.keys(TOOL_SHAPE_SETTING_PATHS);

/**
 * Settings the prompt does not read, whose writes must reach no rebuild.
 *
 * Chosen for inertness as well as for being ungated: a write here must not leave process-global
 * state behind for the next file (`session.instrumentation` installs a level, so it is not one
 * of these), and `tui.tight` is restored by the settings test-state helper. Nor may one be a
 * path this harness passes to `Settings.isolated`: an override outranks the value `set` writes,
 * so the effective value never moves, no change signal fires, and the row would pass whatever
 * the trigger did — `compaction.enabled` sat here and survived a mutation that rebuilt for
 * every write.
 */
const UNGATED_PATHS = ["tui.tight", "async.maxJobs", "todo.reminders"];

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function readTool(): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read tool",
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: "read executed" }] };
		},
	};
}

/**
 * The reasons the session rebuilt for, and a signal for the next rebuild.
 *
 * The rebuild is fire-and-forget on an internal promise chain, so a test needs the completion
 * signal rather than a delay: the spy calls the real method and resolves the pending waiter
 * after it settles, which is the same event the session itself is waiting on.
 */
interface RebuildWatch {
	readonly reasons: string[];
	nextRebuild(): Promise<void>;
}

function watchRebuilds(session: AgentSession): RebuildWatch {
	const reasons: string[] = [];
	let pending: (() => void) | undefined;
	const original = session.refreshBaseSystemPrompt.bind(session);
	vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async (reason: string) => {
		const result = await original(reason);
		reasons.push(reason);
		pending?.();
		pending = undefined;
		return result;
	});
	return {
		reasons,
		nextRebuild(): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			pending = resolve;
			return promise;
		},
	};
}

describe("a settings write rebuilds the prompt it changes", () => {
	let settings: Settings;
	let session: AgentSession;
	let rebuilds: RebuildWatch;
	let rebuildCount = 0;
	let settingsState: SettingsTestState | undefined;

	beforeEach(() => {
		// A write runs the setting's process hook as well as the listener, and a few hooks
		// (`tui.tight`, the theme and markdown flags) live in module scope, so the suite claims
		// the settings test-state slot and restores it rather than leaving one flipped.
		settingsState = beginSettingsTest();
		rebuildCount = 0;
		settings = Settings.isolated({ "compaction.enabled": false });
		const tool = readTool();
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: createModel(), systemPrompt: ["initial"], tools: [tool], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: {} as never,
			toolRegistry: new Map<string, AgentTool>([[tool.name, tool]]),
			rebuildSystemPrompt: async toolNames => {
				rebuildCount++;
				return { systemPrompt: [`tools:${toolNames.join(",")}`] };
			},
		});
		rebuilds = watchRebuilds(session);
	});

	afterEach(async () => {
		await session.dispose();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	/**
	 * A value for `path` that differs from the one it holds.
	 *
	 * The change signal is suppressed for a write of the same value (`Object.is`), so writing
	 * the current value back proves nothing: every write here has to move the setting.
	 */
	function changedValue(path: SettingPath, current: unknown): unknown {
		switch (getType(path)) {
			case "boolean":
				return current !== true;
			case "number":
				return typeof current === "number" ? current + 1 : 1;
			case "enum": {
				const next = (getEnumValues(path) ?? []).find(value => value !== current);
				if (next === undefined) throw new Error(`${path} declares no second enum value to write`);
				return next;
			}
			case "string":
			case "modelChain":
				return `${typeof current === "string" ? current : ""}-moved`;
			case "array":
				// A record and an array signal on identity, so a copy is a change.
				return Array.isArray(current) ? [...current, "moved"] : ["moved"];
			case "record":
				return typeof current === "object" && current !== null ? { ...current } : {};
		}
	}

	/**
	 * Move a setting, the way any writer does.
	 *
	 * The registry carries its rows as plain strings — it cannot import the settings schema
	 * without a cycle — so the sweep narrows here, once, and `names only settings that exist`
	 * below is what makes the narrowing safe rather than assumed.
	 */
	function write(path: string): void {
		const settingPath = path as SettingPath;
		settings.set(settingPath, changedValue(settingPath, settings.get(settingPath)) as never);
	}

	it.each([...LIVE_PROMPT_GATE_SETTINGS])("rebuilds for a write to the live prompt gate %s", async setting => {
		const rebuilt = rebuilds.nextRebuild();

		write(setting);
		await rebuilt;

		expect(rebuilds.reasons, `${setting} did not rebuild the prompt`).toEqual([`setting:${setting}`]);
		expect(rebuildCount, "the rebuild hook never ran, so nothing reached the model").toBe(1);
	});

	it.each(TOOL_SHAPE_PATHS)("rebuilds for a write to the tool-shape setting %s", async setting => {
		const rebuilt = rebuilds.nextRebuild();

		write(setting);
		await rebuilt;

		expect(rebuilds.reasons, `${setting} did not rebuild the prompt`).toEqual([`setting:${setting}`]);
		expect(rebuildCount).toBe(1);
	});

	it.each([...FROZEN_PROMPT_GATE_SETTINGS])("does not rebuild for the frozen gate %s", async setting => {
		// A frozen gate cannot follow a mid-session write: the value it renders was captured at
		// startup, so a rebuild would re-read the old value and charge a full re-prefill to
		// report a change that did not happen.
		const barrier = rebuilds.nextRebuild();

		write(setting);
		// Ordering barrier, not a delay: the listener queues rebuilds on one promise chain in
		// write order, so anything the frozen write scheduled has run by the time this resolves.
		write(TOOL_SHAPE_PATHS[0] as string);
		await barrier;

		expect(rebuilds.reasons).toEqual([`setting:${TOOL_SHAPE_PATHS[0]}`]);
	});

	it.each(UNGATED_PATHS)("does not rebuild for %s, which the prompt does not read", async setting => {
		const barrier = rebuilds.nextRebuild();

		write(setting);
		write(TOOL_SHAPE_PATHS[0] as string);
		await barrier;

		expect(rebuilds.reasons).toEqual([`setting:${TOOL_SHAPE_PATHS[0]}`]);
	});

	it("stops rebuilding once the session is disposed", async () => {
		// A write after teardown must reach no rebuild: the prompt it would rebuild belongs to a
		// session nobody holds any more. THREE guards enforce this — `dispose` unsubscribes the
		// listener, the listener returns early when disposed, and the queued rebuild re-checks
		// before it runs — so this row goes red only when all three are gone. It is a statement
		// of the contract for a teardown rewrite to fail against, not a gate on any one guard;
		// removing any single one leaves it green (verified by mutating each in turn).
		await session.dispose();

		write(LIVE_PROMPT_GATE_SETTINGS[0] as string);
		await session.refreshBaseSystemPrompt("barrier");

		expect(rebuilds.reasons).toEqual(["barrier"]);
	});

	it("names no setting the gate registry already owns", () => {
		// The two lists that disagreed. This one holds what the registry does not: settings that
		// change the TOOL SHAPE and gate no prompt text. A path in both is the drift coming back.
		const registryOwned = new Set<string>(PROMPT_GATE_SETTINGS);
		const restated = TOOL_SHAPE_PATHS.filter(path => registryOwned.has(path));

		expect(restated).toEqual([]);
	});

	it("names only settings that exist", () => {
		// A typo here is a permanently dead trigger that looks exactly like a working one, the
		// same failure `prompt-gate-registry.test.ts` pins for the registry's own rows.
		const declared = new Set<string>(Object.keys(SETTINGS_SCHEMA));
		const unknown = TOOL_SHAPE_PATHS.filter(path => !declared.has(path));

		expect(unknown).toEqual([]);
	});
});
