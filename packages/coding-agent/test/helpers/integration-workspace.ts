/**
 * The one place tests build a REAL end-to-end agent run.
 *
 * Everything below the model is real: the real {@link Agent} loop, the real
 * builtin tool implementations, and a real temp directory those tools read and
 * write. Only the model is scripted, via the shipped {@link createMockModel}
 * provider, so a test states "the model asks for this tool call, then says this"
 * and then asserts on what actually happened on disk and in the message log.
 *
 * Why this exists: the suite had ~159 tests that construct an `AgentSession` and
 * ~65 that spawn the CLI, but NONE that drove a scripted model through the real
 * agent loop into real tools against a real filesystem. Every would-be
 * integration test had to hand-roll ~40 lines of setup (temp dir, settings,
 * registry, agent, tool wiring), which is why so few existed. The cost of that
 * setup was the reason coverage stopped at the unit boundary, so the fix is a
 * harness that makes the real path a few lines to exercise.
 *
 * Contract notes that keep these tests honest:
 *  - A requested tool that the factory cannot build FAILS LOUDLY rather than
 *    being skipped, so a test can never silently assert against a missing tool
 *    and pass for the wrong reason.
 *  - Tool calls are read back off the recorded assistant messages, not off the
 *    mock's internals, so assertions reflect the state the agent actually kept.
 *  - The workspace is a real temp dir; assert file CONTENT, not just that a tool
 *    was called.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@veyyon/agent-core";
import { createMockModel, type MockModel, type MockResponseSource } from "@veyyon/ai/providers/mock";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BUILTIN_TOOLS, type ToolSession } from "@veyyon/coding-agent/tools/index";
import { TempDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./settings-test-state";
import { makeToolSession } from "./tool-session";

/** Tools a file-oriented integration test almost always wants. */
export const DEFAULT_INTEGRATION_TOOLS = ["read", "write", "edit"] as const;

export interface IntegrationWorkspaceOptions {
	/** Files seeded into the workspace before the run, keyed by path relative to the workspace root. */
	files?: Record<string, string>;
	/** Scripted model turns: `{ content: [{ type: "toolCall", name, arguments }] }`, `{ content: ["text"] }`, generators, or handlers. */
	script?: MockResponseSource;
	/** Builtin tools to wire up. Defaults to {@link DEFAULT_INTEGRATION_TOOLS}. */
	tools?: readonly string[];
	/** System prompt lines handed to the agent. */
	systemPrompt?: readonly string[];
	/** Extra `ToolSession` members (e.g. `hasUI`) for tools that consult them. */
	toolSession?: Partial<ToolSession>;
	/** Settings overrides applied to the in-memory Settings the tools read. */
	settings?: Record<string, unknown>;
}

/** A recorded tool call as the agent actually stored it on an assistant message. */
export interface RecordedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface IntegrationWorkspace {
	/** Absolute path to the real workspace directory the tools operate on. */
	readonly cwd: string;
	readonly agent: Agent;
	readonly model: MockModel;
	/** Every agent event emitted during the run, in order. */
	readonly events: AgentEvent[];
	/** Drive one real turn. Resolves when the agent loop settles. */
	send(text: string): Promise<void>;
	/** Read a workspace file. Throws if absent, so a missing file fails loudly. */
	read(relativePath: string): string;
	exists(relativePath: string): boolean;
	/** Write a workspace file mid-test (simulating an external change). */
	seed(relativePath: string, contents: string): void;
	/** Tool calls the agent recorded, in order. */
	toolCalls(): RecordedToolCall[];
	/** Concatenated text of the final assistant message. */
	assistantText(): string;
	/** Text of the most recent ERRORED tool result, or undefined if none errored. */
	lastToolError(): string | undefined;
	/** Text of every tool result, in order, with its error flag. */
	toolResults(): Array<{ tool: string; text: string; isError: boolean }>;
	dispose(): void;
}

/**
 * Build a real workspace, wire real tools to it, and drive them with a scripted
 * model. Call {@link IntegrationWorkspace.dispose} in an `afterEach`.
 */
export async function createIntegrationWorkspace(
	options: IntegrationWorkspaceOptions = {},
): Promise<IntegrationWorkspace> {
	const settingsState: SettingsTestState = beginSettingsTest();
	const tempDir = TempDir.createSync("@veyyon-integration-");
	const cwd = tempDir.path();

	// Real tools consult the global Settings singleton, and NOT initializing it is
	// not a neutral omission: the write tool's create path works without it while
	// its overwrite path fails with "Settings not initialized", so a harness that
	// skipped this would silently test a different code path than production runs.
	// In-memory + rooted at the workspace keeps it hermetic.
	await Settings.init({ inMemory: true, cwd, overrides: (options.settings ?? {}) as never });

	for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
		const absolute = path.join(cwd, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents);
	}

	const toolSession = makeToolSession({ cwd, ...options.toolSession });
	const requested = options.tools ?? DEFAULT_INTEGRATION_TOOLS;
	const tools = [];
	for (const name of requested) {
		const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
		if (!factory) {
			throw new Error(
				`Unknown builtin tool "${name}" requested by an integration test. Known tools: ${Object.keys(BUILTIN_TOOLS).join(", ")}.`,
			);
		}
		const tool = await factory(toolSession);
		if (!tool) {
			// Loud, never a silent skip: a test asserting on a tool that was never
			// wired would otherwise pass for the wrong reason.
			throw new Error(
				`Builtin tool "${name}" could not be constructed for this integration workspace (its factory returned null). ` +
					`Provide the ToolSession members it needs via \`toolSession\`.`,
			);
		}
		tools.push(tool);
	}

	const model = createMockModel({ responses: options.script });
	const agent = new Agent({
		streamFn: model.stream,
		initialState: {
			model,
			systemPrompt: [...(options.systemPrompt ?? ["integration test"])],
			tools,
			messages: [],
		},
	});

	const events: AgentEvent[] = [];
	const unsubscribe = agent.subscribe(event => {
		events.push(event);
	});

	const resolve = (relativePath: string): string => path.join(cwd, relativePath);

	const collectToolResults = (): Array<{ tool: string; text: string; isError: boolean }> => {
		const results: Array<{ tool: string; text: string; isError: boolean }> = [];
		for (const message of agent.state.messages) {
			if (message.role !== "toolResult") continue;
			const record = message as unknown as {
				toolName?: string;
				isError?: boolean;
				content?: ReadonlyArray<{ type?: string; text?: string }>;
			};
			const text = (record.content ?? [])
				.filter(block => block?.type === "text")
				.map(block => block.text ?? "")
				.join("");
			results.push({ tool: record.toolName ?? "", text, isError: record.isError === true });
		}
		return results;
	};

	return {
		cwd,
		agent,
		model,
		events,
		async send(text: string): Promise<void> {
			await agent.prompt(text);
		},
		read(relativePath: string): string {
			const absolute = resolve(relativePath);
			if (!fs.existsSync(absolute)) {
				throw new Error(`Expected workspace file "${relativePath}" to exist at ${absolute}, but it does not.`);
			}
			return fs.readFileSync(absolute, "utf8");
		},
		exists(relativePath: string): boolean {
			return fs.existsSync(resolve(relativePath));
		},
		seed(relativePath: string, contents: string): void {
			const absolute = resolve(relativePath);
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			fs.writeFileSync(absolute, contents);
		},
		toolCalls(): RecordedToolCall[] {
			const calls: RecordedToolCall[] = [];
			for (const message of agent.state.messages) {
				if (message.role !== "assistant") continue;
				for (const block of message.content) {
					if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
						const call = block as { name: string; arguments?: Record<string, unknown> };
						calls.push({ name: call.name, arguments: call.arguments ?? {} });
					}
				}
			}
			return calls;
		},
		assistantText(): string {
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const message = agent.state.messages[i];
				if (message?.role !== "assistant") continue;
				const text = message.content
					.filter(
						(block): block is { type: "text"; text: string } =>
							typeof block === "object" && block !== null && "type" in block && block.type === "text",
					)
					.map(block => block.text)
					.join("");
				if (text) return text;
			}
			return "";
		},
		toolResults(): Array<{ tool: string; text: string; isError: boolean }> {
			return collectToolResults();
		},
		lastToolError(): string | undefined {
			return collectToolResults()
				.filter(result => result.isError)
				.at(-1)?.text;
		},
		dispose(): void {
			unsubscribe();
			tempDir.removeSync();
			restoreSettingsTestState(settingsState);
		},
	};
}
