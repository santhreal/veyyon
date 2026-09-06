import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type {
	ParsedSlashCommand,
	SlashCommandRuntime,
	TuiSlashCommandRuntime,
} from "@veyyon/coding-agent/slash-commands/types";

/**
 * WHY: `/model`, `/switch` and `/effort` are the keyboard path to the model and
 * effort pickers and to a direct effort change. Each case drives the real
 * builtin handler against a session recorder and asserts what the operator
 * observes: the printed line, the model or level the session now holds, the
 * selector that opened, and the composer text cleared. Not covered: the
 * selector components themselves (see the widths-and-states suite).
 */

function makeNoEffortModel(provider = "test-provider", id = "no-effort-model"): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

interface SessionRecorder {
	session: AgentSession;
	/** Every `setModel` / `setModelTemporary` argument, in order. */
	modelsSet: Model[];
	/** Every `setThinkingLevel` call as `[level, persist]`, in order. */
	levelsSet: Array<[string, boolean | undefined]>;
}

function makeSession(model?: Model, configuredLevel?: string): SessionRecorder {
	let currentModel = model;
	let currentLevel = configuredLevel;
	const modelsSet: Model[] = [];
	const levelsSet: Array<[string, boolean | undefined]> = [];
	const session = {
		get model() {
			return currentModel;
		},
		getAvailableModels: () => (currentModel ? [currentModel] : []),
		configuredThinkingLevel: () => currentLevel,
		async setModel(m: Model): Promise<void> {
			currentModel = m;
			modelsSet.push(m);
		},
		async setModelTemporary(m: Model): Promise<void> {
			currentModel = m;
			modelsSet.push(m);
		},
		setThinkingLevel(lvl: string, persist?: boolean): void {
			currentLevel = lvl;
			levelsSet.push([lvl, persist]);
		},
		resolveTemporaryModelThinkingLevel: () => undefined,
		getContextUsage: () => ({ tokens: 1000 }),
		modelRegistry: {
			authStorage: {
				hasAuth: () => true,
				getAuth: () => undefined,
			},
		},
	} as unknown as AgentSession;
	return { session, modelsSet, levelsSet };
}

interface HeadlessRecorder {
	runtime: SlashCommandRuntime;
	printed: string[];
}

function makeHeadless(session: AgentSession): HeadlessRecorder {
	const printed: string[] = [];
	const runtime = {
		session,
		output: (line: string) => {
			printed.push(line);
		},
		notifyTitleChanged(): void {},
		notifyConfigChanged(): void {},
	} as unknown as SlashCommandRuntime;
	return { runtime, printed };
}

interface TuiRecorder {
	runtime: TuiSlashCommandRuntime;
	/** Arguments of each `showModelSelector` call. */
	modelSelectorOpened: unknown[];
	/** One entry per `showThinkingSelector` call. */
	thinkingSelectorOpened: number;
	editorText: string[];
	statuses: string[];
}

function makeTui(session?: AgentSession): TuiRecorder {
	const rec: TuiRecorder = {
		runtime: undefined as unknown as TuiSlashCommandRuntime,
		modelSelectorOpened: [],
		thinkingSelectorOpened: 0,
		editorText: [],
		statuses: [],
	};
	rec.runtime = {
		ctx: {
			session,
			showModelSelector(options?: unknown): void {
				rec.modelSelectorOpened.push(options);
			},
			showThinkingSelector(): void {
				rec.thinkingSelectorOpened += 1;
			},
			showStatus(text: string): void {
				rec.statuses.push(text);
			},
			statusLine: { invalidate(): void {} },
			updateEditorBorderColor(): void {},
			editor: {
				setText(text: string): void {
					rec.editorText.push(text);
				},
			},
			ui: { requestRender(): void {} },
		},
	} as unknown as TuiSlashCommandRuntime;
	return rec;
}

function consumed(result: unknown): boolean {
	return typeof result === "object" && result !== null && "consumed" in result && result.consumed === true;
}

describe("Model and effort slash commands and controllers", () => {
	const astra = getBundledModel("openai-codex", "gpt-6-astra")!;
	const noEffort = makeNoEffortModel();

	const modelCmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(cmd => cmd.name === "model")!;
	const switchCmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(cmd => cmd.name === "switch")!;
	const effortCmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(cmd => cmd.name === "effort")!;

	describe("/model command", () => {
		it("headless: shows current model when called with no args", async () => {
			const { session } = makeSession(astra);
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = { name: "model", args: "", text: "/model" };
			const result = await modelCmd.handle!(cmd, runtime);
			expect(printed).toEqual(["Current model: openai-codex/gpt-6-astra"]);
			expect(consumed(result)).toBe(true);
		});

		it("headless: sets model when called with valid model id", async () => {
			const { session, modelsSet } = makeSession(astra);
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = { name: "model", args: "gpt-6-astra", text: "/model gpt-6-astra" };
			const result = await modelCmd.handle!(cmd, runtime);
			expect(modelsSet).toEqual([astra]);
			expect(session.model).toBe(astra);
			expect(printed).toEqual(["Model set to openai-codex/gpt-6-astra."]);
			expect(consumed(result)).toBe(true);
		});

		it("headless: returns error usage when model is unknown", async () => {
			const { session, modelsSet } = makeSession(astra);
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = {
				name: "model",
				args: "nonexistent-model",
				text: "/model nonexistent-model",
			};
			const result = await modelCmd.handle!(cmd, runtime);
			expect(printed).toHaveLength(1);
			expect(printed[0]).toContain("Unknown model: nonexistent-model");
			expect(modelsSet).toEqual([]);
			expect(consumed(result)).toBe(true);
		});

		it("TUI: opens the model selector and clears the composer", () => {
			const rec = makeTui();
			const cmd: ParsedSlashCommand = { name: "model", args: "", text: "/model" };
			modelCmd.handleTui!(cmd, rec.runtime);
			expect(rec.modelSelectorOpened).toHaveLength(1);
			expect(rec.editorText).toEqual([""]);
		});

		it("TUI: /switch opens the model selector in temporary-only mode", () => {
			const rec = makeTui();
			const cmd: ParsedSlashCommand = { name: "switch", args: "", text: "/switch" };
			switchCmd.handleTui!(cmd, rec.runtime);
			expect(rec.modelSelectorOpened).toEqual([{ temporaryOnly: true }]);
			expect(rec.editorText).toEqual([""]);
		});
	});

	describe("/effort command", () => {
		it("headless: shows current effort choices when called with no args on gpt-6-astra", async () => {
			const { session } = makeSession(astra, "high");
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = { name: "effort", args: "", text: "/effort" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(printed).toHaveLength(1);
			expect(printed[0]).toContain("Effort: high (this session)");
			expect(printed[0]).toContain("off, auto, low, medium, high, xhigh, max");
			expect(consumed(result)).toBe(true);
		});

		it("headless: shows no reasoning control message for no-effort model", async () => {
			const { session } = makeSession(noEffort);
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = { name: "effort", args: "", text: "/effort" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(printed).toEqual(["test-provider/no-effort-model does not reason; there is no effort to set."]);
			expect(consumed(result)).toBe(true);
		});

		it("headless: sets valid effort level for this session", async () => {
			const { session, levelsSet } = makeSession(astra);
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = { name: "effort", args: "max", text: "/effort max" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(levelsSet).toEqual([[ThinkingLevel.Max, false]]);
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Max);
			expect(printed).toHaveLength(1);
			expect(printed[0]).toContain("Effort set to max for this session.");
			expect(consumed(result)).toBe(true);
		});

		it("headless: rejects unsupported effort level", async () => {
			const { session, levelsSet } = makeSession(astra);
			const { runtime, printed } = makeHeadless(session);

			const cmd: ParsedSlashCommand = { name: "effort", args: "superhigh", text: "/effort superhigh" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(printed).toHaveLength(1);
			expect(printed[0]).toContain("Unknown thinking level: superhigh");
			expect(levelsSet).toEqual([]);
			expect(consumed(result)).toBe(true);
		});

		it("TUI: bare /effort opens the thinking selector", () => {
			const rec = makeTui(makeSession(astra).session);
			const cmd: ParsedSlashCommand = { name: "effort", args: "", text: "/effort" };
			effortCmd.handleTui!(cmd, rec.runtime);
			expect(rec.thinkingSelectorOpened).toBe(1);
			expect(rec.editorText).toEqual([""]);
		});

		it("TUI: /effort <level> sets effort directly and displays status", () => {
			const { session, levelsSet } = makeSession(astra);
			const rec = makeTui(session);
			const cmd: ParsedSlashCommand = { name: "effort", args: "high", text: "/effort high" };
			effortCmd.handleTui!(cmd, rec.runtime);
			expect(levelsSet).toEqual([[ThinkingLevel.High, false]]);
			expect(rec.thinkingSelectorOpened).toBe(0);
			expect(rec.statuses).toHaveLength(1);
			expect(rec.statuses[0]).toContain("Effort set to high for this session.");
		});

		it("TUI: /effort on no-effort model displays reason status", () => {
			const { session, levelsSet } = makeSession(noEffort);
			const rec = makeTui(session);
			const cmd: ParsedSlashCommand = { name: "effort", args: "high", text: "/effort high" };
			effortCmd.handleTui!(cmd, rec.runtime);
			expect(rec.statuses).toEqual(["test-provider/no-effort-model does not reason; there is no effort to set."]);
			expect(levelsSet).toEqual([]);
		});
	});
});
