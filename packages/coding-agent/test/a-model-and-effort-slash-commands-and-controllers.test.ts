import { describe, expect, it, vi } from "bun:test";
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

function makeMockSession(model?: Model, configuredLevel?: string): AgentSession {
	let currentModel = model;
	let currentLevel = configuredLevel;
	return {
		model: currentModel,
		getAvailableModels: () => (currentModel ? [currentModel] : []),
		configuredThinkingLevel: () => currentLevel,
		setModel: vi.fn(async (m: Model) => {
			currentModel = m;
		}),
		setModelTemporary: vi.fn(async (m: Model) => {
			currentModel = m;
		}),
		setThinkingLevel: vi.fn((lvl: string, _persist?: boolean) => {
			currentLevel = lvl;
		}),
		resolveTemporaryModelThinkingLevel: vi.fn(() => undefined),
		getContextUsage: vi.fn(() => ({ tokens: 1000 })),
		modelRegistry: {
			authStorage: {
				hasAuth: () => true,
				getAuth: () => undefined,
			},
		},
	} as unknown as AgentSession;
}

describe("Model and effort slash commands and controllers", () => {
	const astra = getBundledModel("openai-codex", "gpt-6-astra")!;
	const noEffort = makeNoEffortModel();

	const modelCmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(cmd => cmd.name === "model")!;
	const switchCmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(cmd => cmd.name === "switch")!;
	const effortCmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(cmd => cmd.name === "effort")!;

	describe("/model command", () => {
		it("headless: shows current model when called with no args", async () => {
			const session = makeMockSession(astra);
			const output = vi.fn();
			const runtime = {
				session,
				output,
				notifyTitleChanged: vi.fn(),
				notifyConfigChanged: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "model", args: "", text: "/model" };
			const result = await modelCmd.handle!(cmd, runtime);
			expect(output).toHaveBeenCalledWith("Current model: openai-codex/gpt-6-astra");
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("headless: sets model when called with valid model id", async () => {
			const session = makeMockSession(astra);
			const output = vi.fn();
			const runtime = {
				session,
				output,
				notifyTitleChanged: vi.fn(),
				notifyConfigChanged: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "model", args: "gpt-6-astra", text: "/model gpt-6-astra" };
			const result = await modelCmd.handle!(cmd, runtime);
			expect(session.setModel).toHaveBeenCalledWith(astra);
			expect(output).toHaveBeenCalledWith("Model set to openai-codex/gpt-6-astra.");
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("headless: returns error usage when model is unknown", async () => {
			const session = makeMockSession(astra);
			const output = vi.fn();
			const runtime = {
				session,
				output,
				notifyTitleChanged: vi.fn(),
				notifyConfigChanged: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = {
				name: "model",
				args: "nonexistent-model",
				text: "/model nonexistent-model",
			};
			const result = await modelCmd.handle!(cmd, runtime);
			expect(output).toHaveBeenCalledWith(expect.stringContaining("Unknown model: nonexistent-model"));
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("TUI: calls showModelSelector and clears editor", () => {
			const showModelSelector = vi.fn();
			const setText = vi.fn();
			const runtime = {
				ctx: {
					showModelSelector,
					editor: { setText },
				},
			} as unknown as TuiSlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "model", args: "", text: "/model" };
			modelCmd.handleTui!(cmd, runtime);
			expect(showModelSelector).toHaveBeenCalled();
			expect(setText).toHaveBeenCalledWith("");
		});

		it("TUI: /switch calls showModelSelector with temporaryOnly: true", () => {
			const showModelSelector = vi.fn();
			const setText = vi.fn();
			const runtime = {
				ctx: {
					showModelSelector,
					editor: { setText },
				},
			} as unknown as TuiSlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "switch", args: "", text: "/switch" };
			switchCmd.handleTui!(cmd, runtime);
			expect(showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
			expect(setText).toHaveBeenCalledWith("");
		});
	});

	describe("/effort command", () => {
		it("headless: shows current effort choices when called with no args on gpt-6-astra", async () => {
			const session = makeMockSession(astra, "high");
			const output = vi.fn();
			const runtime = {
				session,
				output,
				notifyConfigChanged: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "", text: "/effort" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(output).toHaveBeenCalled();
			const msg = output.mock.calls[0][0];
			expect(msg).toContain("Effort: high (this session)");
			expect(msg).toContain("off, auto, low, medium, high, xhigh, max");
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("headless: shows no reasoning control message for no-effort model", async () => {
			const session = makeMockSession(noEffort);
			const output = vi.fn();
			const runtime = {
				session,
				output,
				notifyConfigChanged: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "", text: "/effort" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(output).toHaveBeenCalledWith(
				"test-provider/no-effort-model does not reason; there is no effort to set.",
			);
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("headless: sets valid effort level for this session", async () => {
			const session = makeMockSession(astra);
			const output = vi.fn();
			const runtime = {
				session,
				output,
				notifyConfigChanged: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "max", text: "/effort max" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(session.setThinkingLevel).toHaveBeenCalledWith(ThinkingLevel.Max, false);
			expect(output).toHaveBeenCalled();
			expect(output.mock.calls[0][0]).toContain("Effort set to max for this session.");
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("headless: rejects unsupported effort level", async () => {
			const session = makeMockSession(astra);
			const output = vi.fn();
			const runtime = {
				session,
				output,
			} as unknown as SlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "superhigh", text: "/effort superhigh" };
			const result = await effortCmd.handle!(cmd, runtime);
			expect(output).toHaveBeenCalledWith(expect.stringContaining("Unknown thinking level: superhigh"));
			expect(result && "consumed" in result && result.consumed).toBe(true);
		});

		it("TUI: bare /effort calls showThinkingSelector", () => {
			const showThinkingSelector = vi.fn();
			const setText = vi.fn();
			const runtime = {
				ctx: {
					session: makeMockSession(astra),
					showThinkingSelector,
					editor: { setText },
				},
			} as unknown as TuiSlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "", text: "/effort" };
			effortCmd.handleTui!(cmd, runtime);
			expect(showThinkingSelector).toHaveBeenCalled();
			expect(setText).toHaveBeenCalledWith("");
		});

		it("TUI: /effort <level> sets effort directly and displays status", () => {
			const session = makeMockSession(astra);
			const showStatus = vi.fn();
			const setText = vi.fn();
			const runtime = {
				ctx: {
					session,
					showStatus,
					statusLine: { invalidate: vi.fn() },
					updateEditorBorderColor: vi.fn(),
					editor: { setText },
					ui: { requestRender: vi.fn() },
				},
			} as unknown as TuiSlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "high", text: "/effort high" };
			effortCmd.handleTui!(cmd, runtime);
			expect(session.setThinkingLevel).toHaveBeenCalledWith(ThinkingLevel.High, false);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Effort set to high for this session."));
		});

		it("TUI: /effort on no-effort model displays reason status", () => {
			const session = makeMockSession(noEffort);
			const showStatus = vi.fn();
			const setText = vi.fn();
			const runtime = {
				ctx: {
					session,
					showStatus,
					editor: { setText },
				},
			} as unknown as TuiSlashCommandRuntime;

			const cmd: ParsedSlashCommand = { name: "effort", args: "high", text: "/effort high" };
			effortCmd.handleTui!(cmd, runtime);
			expect(showStatus).toHaveBeenCalledWith(
				"test-provider/no-effort-model does not reason; there is no effort to set.",
			);
		});
	});
});
