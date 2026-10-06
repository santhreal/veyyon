/**
 * The RPC commands: one handler per `RpcCommand` type, and the response frame each one answers with.
 *
 * A handler returns the response's `data`, or `undefined` for a response without it, and throws to
 * refuse: {@link handleRpcCommand} frames both under the command's own `id` and `type`.
 */
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Model } from "@veyyon/ai";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { isZodSchema, zodToWireSchema } from "@veyyon/ai/utils/schema";
import { errorMessage, Snowflake } from "@veyyon/utils";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import type { AgentSession } from "../../session/agent-session";
import { type BackgroundHandoff, BackgroundSessions } from "../../session/background-sessions";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../../slash-commands/types";
import { configuredThinkingLevelsForModel } from "../../thinking";
import type { RpcHostToolBridge } from "./host-tools";
import type { RpcHostUriBridge } from "./host-uris";
import { type RpcAgentRegistry, readRpcAgentTranscript } from "./rpc-agents";
import { type RpcExtensionUserMessageTracker, watchAndReportLocalOnlyPromptResult } from "./rpc-prompt-result";
import type { RpcSessionSlot } from "./rpc-session-slot";
import type {
	RpcAgentSubscriptionLevel,
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcHostToolDefinition,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types";

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export type RpcAgentResetRegistry = Pick<RpcAgentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	agentRegistry?: RpcAgentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) agentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) agentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) agentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
		};
	});
}

function isAgentSubscriptionLevel(value: unknown): value is RpcAgentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

/**
 * Build a successful RPC response frame. One owner for id/command/success shape
 * so hosts and tests share the same wire contract as `runRpcMode`.
 */
export function rpcSuccessResponse<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

/**
 * Build a failed RPC response frame. Request id is caller-supplied; the unknown-
 * command path deliberately passes `undefined` so a bad type never echoes id.
 */
export function rpcErrorResponse(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

/**
 * Default arm for an unrecognized command discriminant: always drop request id
 * and surface `Unknown command: <type>`. This is the single owner of that rule
 * (also used by the regression corpus — do not re-implement in tests).
 */
export function rpcUnknownCommandResponse(commandType: string): RpcResponse {
	return rpcErrorResponse(undefined, commandType, `Unknown command: ${commandType}`);
}

/**
 * Why `set_thinking_level` must be refused, or `undefined` when it is accepted.
 *
 * An RPC client is an effort-choosing surface like any other, so it is held to the
 * SAME narrowing the pickers, `/effort` and ACP's `thought_level` option use: the
 * levels the model in scope declares, and nothing else. Before this it applied
 * whatever arrived and answered `success`, while `AgentSession.setThinkingLevel`
 * quietly clamped the value to a supported neighbour (or dropped it) — so a client
 * was told `xhigh` was set on a model that has no such wire field, and the log line
 * naming the clamp went somewhere the client never reads. Refusing is what the
 * neighbouring `set_model` arm already does for an unknown model.
 *
 * `inherit` is always accepted: it is how a client clears its choice, not a level,
 * and it is the one value every picker keeps offering for exactly that reason. No
 * model in scope means no row to narrow against, so nothing is refused: a client
 * that sets a level before a model resolves is not making a mistake this function
 * can see. That is a decision HERE, not a fallback ladder in the narrowing helper,
 * which offers nothing for a model it cannot read.
 */
export function rpcThinkingLevelRefusal(model: Model | undefined, level: ThinkingLevel): string | undefined {
	if (level === ThinkingLevel.Inherit) return undefined;
	if (!model) return undefined;
	const choices = configuredThinkingLevelsForModel(model);
	if (choices.includes(level)) return undefined;
	const accepted = choices.length > 0 ? choices.join(", ") : "none (this model exposes no effort control)";
	const subject = model ? `${model.provider}/${model.id}` : "The active model";
	return `${subject} does not accept thinking level ${level}. Accepted: ${accepted}`;
}

/** What a command reaches beyond the session it was sent to. One host serves every session the client drives. */
export interface RpcCommandHost {
	/** Writes one frame to the client. */
	readonly output: (frame: object) => void;
	readonly slot: Pick<RpcSessionSlot, "background" | "reclaim">;
	/** Absent when the server has no agent event bus. */
	readonly agentRegistry: RpcAgentRegistry | undefined;
	readonly hostTools: Pick<RpcHostToolBridge, "setTools">;
	readonly hostUris: Pick<RpcHostUriBridge, "setSchemes">;
	readonly uiContext: Pick<ExtensionUIContext, "notify" | "input">;
	readonly extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	/** The slash commands the attached session offers. */
	readonly availableCommands: () => Promise<RpcAvailableSlashCommand[]>;
	/** Sends `available_commands_update`. */
	readonly emitAvailableCommandsUpdate: () => Promise<void>;
	/** Reloads plugin roots, capabilities and slash commands, then sends `available_commands_update`. */
	readonly reloadPlugins: () => Promise<void>;
}

type RpcCommandType = RpcCommand["type"];
type RpcCommandOf<T extends RpcCommandType> = Extract<RpcCommand, { type: T }>;

/** A response's `data`: `undefined` sends the response without the field. */
type RpcCommandData = object | null | undefined;

/** Returns the response's `data`, or nothing for a response without it; throws to refuse. */
type RpcCommandHandler<T extends RpcCommandType> = (
	command: RpcCommandOf<T>,
	session: AgentSession,
	host: RpcCommandHost,
) => Promise<RpcCommandData> | Promise<void> | RpcCommandData | void;

function requireAgentRegistry(host: RpcCommandHost): RpcAgentRegistry {
	if (!host.agentRegistry) throw new Error("Agent event bus is unavailable");
	return host.agentRegistry;
}

/** Start `startPrompt` without awaiting it: events stream, and `prompt_result` follows when it stays local. */
function startReportedPrompt(
	command: RpcCommandOf<"prompt">,
	host: RpcCommandHost,
	startPrompt: () => Promise<boolean>,
): void {
	watchAndReportLocalOnlyPromptResult({
		id: command.id,
		startPrompt,
		output: host.output,
		onError: promptError => host.output(rpcErrorResponse(command.id, "prompt", promptError.message)),
		extensionUserMessageTracker: host.extensionUserMessageTracker,
	});
}

function slashCommandRuntime(session: AgentSession, host: RpcCommandHost): SlashCommandRuntime {
	return {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		cwd: session.sessionManager.getCwd(),
		output: text => host.output({ type: "command_output", text }),
		refreshCommands: host.emitAvailableCommandsUpdate,
		reloadPlugins: host.reloadPlugins,
		notifyTitleChanged: async () => {
			host.output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
		},
		notifyConfigChanged: async () => {
			host.output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
		},
	};
}

/**
 * A skill invocation runs the skill, a builtin slash command runs locally, and anything else is
 * sent to the agent. Extension commands run at once and file prompt templates expand; while a turn
 * streams, `streamingBehavior` queues the text as steering or a follow-up.
 */
async function promptCommand(
	command: RpcCommandOf<"prompt">,
	session: AgentSession,
	host: RpcCommandHost,
): Promise<RpcCommandData> {
	const skillResult = await tryRunRpcSkillCommand(session, command.message, command.streamingBehavior);
	if (skillResult) return skillResult;
	const builtin = await executeAcpBuiltinSlashCommand(command.message, slashCommandRuntime(session, host));
	if (builtin === false) {
		startReportedPrompt(command, host, () =>
			session.prompt(command.message, { images: command.images, streamingBehavior: command.streamingBehavior }),
		);
		return undefined;
	}
	if (!("prompt" in builtin)) return { agentInvoked: false };
	startReportedPrompt(command, host, () => session.prompt(builtin.prompt, { images: command.images }));
	return undefined;
}

/**
 * `new_session` with `background` and `switch_session` to a background conversation's transcript
 * move the attached session to the background; every other change resets or loads in place.
 */
async function changeSession(
	command: RpcSessionChangeCommand,
	session: AgentSession,
	host: RpcCommandHost,
): Promise<RpcCommandData> {
	let background: BackgroundHandoff | undefined;
	if (command.type === "new_session" && command.background) {
		if (command.parentSession !== undefined) {
			throw new Error("new_session cannot combine background with parentSession");
		}
		background = await host.slot.background();
	} else if (command.type === "switch_session") {
		background = host.slot.reclaim(command.sessionPath);
	}
	if (background) {
		host.agentRegistry?.clear();
		await host.emitAvailableCommandsUpdate();
		return { cancelled: false, background };
	}
	const result = await handleRpcSessionChange(session, command, host.agentRegistry);
	if (!result.data.cancelled) await host.emitAvailableCommandsUpdate();
	return result.data;
}

/**
 * OAuth login with no terminal: the authorization URL is sent as an `open_url` request, progress as
 * notifications, and the pasted code or redirect URL is read through an `input` dialog.
 */
async function loginCommand(
	command: RpcCommandOf<"login">,
	session: AgentSession,
	host: RpcCommandHost,
): Promise<RpcCommandData> {
	const provider = getOAuthProviders().find(candidate => candidate.id === command.providerId);
	if (!provider) throw new Error(`Unknown OAuth provider: ${command.providerId}`);
	// A provider that prompts before it has sent an authorization URL needs interactive input no
	// RPC client can supply; after the URL, a prompt reads the pasted OAuth code or redirect URL.
	let authEmitted = false;
	await session.modelRegistry.authStorage.login(command.providerId, {
		onAuth: info => {
			authEmitted = true;
			host.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "open_url",
				url: info.url,
				launchUrl: info.launchUrl,
				instructions: info.instructions,
				credential: provider.credential,
			} as RpcExtensionUIRequest);
		},
		onProgress: message => {
			host.uiContext.notify(message, "info");
		},
		onPrompt: async prompt => {
			if (!authEmitted) {
				throw new Error(
					`Provider '${command.providerId}' requires interactive prompts ` +
						"which are not supported in RPC mode. Use the terminal UI to log in.",
				);
			}
			return (
				(await host.uiContext.input(prompt.message, prompt.placeholder, {
					timeout: 600_000,
					// Absent means masked, the same reading the terminal dialog gives it.
					secret: prompt.secret !== false,
				})) ?? ""
			);
		},
	});
	await session.modelRegistry.refresh();
	return { providerId: command.providerId };
}

const RPC_COMMAND_HANDLERS: { readonly [T in RpcCommandType]: RpcCommandHandler<T> } = {
	// Prompting
	prompt: promptCommand,
	steer: async (command, session) => {
		await session.steer(command.message, command.images);
	},
	follow_up: async (command, session) => {
		await session.followUp(command.message, command.images);
	},
	abort: async (_command, session) => {
		await session.abort({ reason: USER_INTERRUPT_LABEL });
	},
	abort_and_prompt: async (command, session, host) => {
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		session
			.prompt(command.message, { images: command.images })
			.catch(e => host.output(rpcErrorResponse(command.id, "abort_and_prompt", e.message)));
	},
	new_session: changeSession,

	// State
	get_state: (_command, session): RpcSessionState => ({
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		queuedMessageCount: session.queuedMessageCount,
		todoPhases: session.getTodoPhases(),
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
	}),
	get_available_commands: async (_command, _session, host) => ({ commands: await host.availableCommands() }),
	set_todos: (command, session) => {
		session.setTodoPhases(command.phases);
		return { todoPhases: session.getTodoPhases() };
	},
	set_host_tools: async (command, session, host) => {
		const tools = normalizeHostToolDefinitions(command.tools);
		await session.refreshRpcHostTools(host.hostTools.setTools(tools));
		return { toolNames: tools.map(tool => tool.name) };
	},
	set_host_uri_schemes: (command, _session, host) => ({ schemes: host.hostUris.setSchemes(command.schemes) }),
	set_subagent_subscription: (command, _session, host) => {
		const registry = requireAgentRegistry(host);
		if (!isAgentSubscriptionLevel(command.level)) {
			throw new Error(`Invalid agent subscription level: ${String(command.level)}`);
		}
		registry.setSubscriptionLevel(command.level);
		return { level: registry.getSubscriptionLevel() };
	},
	get_subagents: (_command, _session, host) => ({ agents: requireAgentRegistry(host).getAgents() }),
	get_subagent_messages: (command, _session, host) => {
		const registry = requireAgentRegistry(host);
		if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
			throw new Error("fromByte must be a finite number");
		}
		return readRpcAgentTranscript(registry.resolveSessionFile(command), command.fromByte);
	},

	// Model
	set_model: async (command, session) => {
		const model = session
			.getAvailableModels()
			.find(candidate => candidate.provider === command.provider && candidate.id === command.modelId);
		if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
		await session.setModel(model);
		return model;
	},
	cycle_model: async (_command, session) => (await session.cycleModel()) ?? null,
	get_available_models: (_command, session) => ({ models: session.getAvailableModels() }),

	// Thinking
	set_thinking_level: (command, session) => {
		const refusal = rpcThinkingLevelRefusal(session.model, command.level);
		if (refusal) throw new Error(refusal);
		session.setThinkingLevel(command.level);
	},
	cycle_thinking_level: (_command, session) => {
		const level = session.cycleThinkingLevel();
		return level ? { level } : null;
	},

	// Queue modes
	set_steering_mode: (command, session) => {
		session.setSteeringMode(command.mode);
	},
	set_follow_up_mode: (command, session) => {
		session.setFollowUpMode(command.mode);
	},
	set_interrupt_mode: (command, session) => {
		session.setInterruptMode(command.mode);
	},

	// Compaction
	compact: (command, session) => session.compact(command.customInstructions),
	set_auto_compaction: (command, session) => {
		session.setAutoCompactionEnabled(command.enabled);
	},

	// Retry
	set_auto_retry: (command, session) => {
		session.setAutoRetryEnabled(command.enabled);
	},
	abort_retry: (_command, session) => {
		session.abortRetry();
	},

	// Bash
	bash: (command, session) => session.executeBash(command.command),
	abort_bash: (_command, session) => {
		session.abortBash();
	},

	// Session
	get_session_stats: (_command, session) => session.getSessionStats(),
	export_html: async (command, session) => ({ path: await session.exportToHtml(command.outputPath) }),
	switch_session: changeSession,
	branch: changeSession,
	get_branch_messages: (_command, session) => ({ messages: session.getUserMessagesForBranching() }),
	get_last_assistant_text: (_command, session) => ({ text: session.getLastAssistantText() }),
	set_session_name: async (command, session) => {
		const name = command.name.trim();
		if (!name || !(await session.setSessionName(name, "user"))) throw new Error("Session name cannot be empty");
	},
	handoff: async (command, session) => {
		// Resetting the agent mid-stream lets the live turn keep emitting into a session the handoff
		// already tore down, so a handoff waits for the response to end, as the TUI /handoff does.
		if (session.isStreaming) throw new Error("Cannot hand off while a response is in progress");
		const result = await session.handoff(command.customInstructions);
		return result ? { savedPath: result.savedPath } : null;
	},

	// Background conversations
	get_background_sessions: () => ({ sessions: BackgroundSessions.global().list() }),
	cancel_background_session: async command => {
		if (!(await BackgroundSessions.global().cancel(command.sessionId, USER_INTERRUPT_LABEL))) {
			throw new Error(`No background conversation ${command.sessionId}`);
		}
		return { sessionId: command.sessionId };
	},

	// Messages
	get_messages: (_command, session) => ({ messages: session.messages }),

	// Login
	get_login_providers: (_command, session) => ({
		providers: getOAuthProviders().map(provider => ({
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
		})),
	}),
	login: loginCommand,
};

/** The command types this server answers, in protocol order. */
export const RPC_COMMAND_TYPES = Object.keys(RPC_COMMAND_HANDLERS) as readonly RpcCommandType[];

/**
 * Answer one command against `session`, the session the client drove when the command arrived. A
 * type with no handler answers `Unknown command`, including a name `Object.prototype` defines.
 */
export async function handleRpcCommand(
	command: RpcCommand,
	session: AgentSession,
	host: RpcCommandHost,
): Promise<RpcResponse> {
	if (!Object.hasOwn(RPC_COMMAND_HANDLERS, command.type)) return rpcUnknownCommandResponse(command.type);
	const handler = RPC_COMMAND_HANDLERS[command.type] as RpcCommandHandler<RpcCommandType>;
	try {
		// A handler that returns nothing resolves `undefined`, which sends the response without `data`.
		const data = (await handler(command, session, host)) as RpcCommandData;
		return rpcSuccessResponse(command.id, command.type, data);
	} catch (err: unknown) {
		return rpcErrorResponse(command.id, command.type, errorMessage(err));
	}
}
