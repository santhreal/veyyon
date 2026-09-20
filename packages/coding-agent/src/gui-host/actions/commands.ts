import { errorMessage } from "@veyyon/utils";
import { reset as resetCapabilities } from "../../discovery/capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { runSkillCommand } from "../../slash-commands/skill-dispatch";
import { buildCommandsView } from "../commands-view";
import { writeFrame } from "../frames";
import { publishModelsView } from "../models-view";
import { reportQueuedPrompts } from "../queued-prompts";
import { executePromptTurn, getOrCreateAgentSession } from "../turns";
import type { TranscriptEntry } from "../wire";
import { activateSession, emitActiveSession, replyError } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

const handleListCommands: ActionHandler = async ctx => {
	try {
		const commands = await buildCommandsView(ctx.clientState);
		ctx.reply.snapshot({ Commands: commands });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Session",
			code: "COMMAND_LIST_FAILED",
			message: errorMessage(error),
			retryable: true,
		});
	}
};

interface RunCommandPayload {
	session?: string;
	text?: string;
}

/**
 * What a command printed, drawn where the terminal draws it: in the
 * conversation, under the command that produced it.
 *
 * The entry is sent and not recorded. A command's output is what the terminal
 * writes to its status line, so it is neither part of the session file nor of
 * the context the next turn is built from; reloading the transcript drops it,
 * exactly as leaving the terminal screen does.
 */
function appendCommandOutput(ctx: ActionContext, command: string, text: string): void {
	ctx.clientState.revision += 1;
	const entry: TranscriptEntry = {
		id: `command-output-${ctx.clientState.revision}`,
		parent: null,
		revision: ctx.clientState.revision,
		timestamp_ms: Date.now(),
		role: "Custom",
		content: [{ Text: { text } }],
		meta: null,
		raw_discriminator: "command_output",
		raw: { command, text },
	};
	writeFrame(ctx.socket, {
		TranscriptAppended: { revision: ctx.clientState.revision, entries: [entry] },
	});
}

/**
 * Reload the plugin state a command changed, the way every other headless
 * client does: drop the cached roots, reset provider capability discovery,
 * re-read the workspace's command files and re-advertise what is there.
 */
async function reloadPlugins(ctx: ActionContext): Promise<void> {
	const session = ctx.clientState.agentSession;
	if (!session) return;
	const cwd = session.sessionManager.getCwd();
	const projectPath = await resolveActiveProjectRegistryPath(cwd);
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	resetCapabilities();
	session.setSlashCommands(await loadSlashCommands({ cwd }));
	await session.refreshSshTool({ activateIfAvailable: true });
}

const handleRunCommand: ActionHandler<RunCommandPayload | undefined> = async (ctx, payload) => {
	const typed = payload?.text?.trim();
	if (!payload?.session || !typed) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "RunCommand requires session and text",
			retryable: false,
		});
		return;
	}
	// A command is advertised by its bare name, so that is how a client that
	// took a row off the catalogue sends it back. A client echoing what was
	// typed sends the slash it was typed with, and both name one command.
	const text = typed.startsWith("/") ? typed : `/${typed}`;
	if (!parseSlashCommand(text)) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOT_A_COMMAND",
			message: `${typed} is not a command; submit it as a prompt`,
			retryable: false,
		});
		return;
	}

	try {
		if (!(await activateSession(ctx, payload.session))) return;
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);

		// A skill invocation is a prompt the skill builds, so it is answered
		// before the builtin table is consulted: the two name spaces are
		// separate and a skill never shadows a builtin.
		if (await runSkillCommand(session, text, ctx.clientState.queueMode === "Queue" ? "followUp" : "steer")) {
			reportQueuedPrompts(ctx.socket, ctx.clientState);
			ctx.reply.success();
			return;
		}

		const result = await executeAcpBuiltinSlashCommand(text, {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: line => appendCommandOutput(ctx, text, line),
			refreshCommands: async () => {
				ctx.reply.snapshot({ Commands: await buildCommandsView(ctx.clientState) });
			},
			reloadPlugins: () => reloadPlugins(ctx),
			notifyTitleChanged: () => {
				const sm = ctx.clientState.sessionManager;
				if (sm) emitActiveSession(ctx, sm);
			},
			notifyConfigChanged: () => publishModelsView(ctx.socket, ctx),
		});

		// `false` is a name the builtin table does not answer to, which is an
		// extension command, a project command file or an MCP prompt: the
		// session expands each of those itself when the prompt starts with a
		// slash. `{ prompt }` is what a builtin left behind for the model.
		const prompt = result === false ? text : "prompt" in result ? result.prompt : undefined;
		if (prompt !== undefined) {
			const streaming = session.isStreaming
				? ctx.clientState.queueMode === "Queue"
					? "followUp"
					: "steer"
				: undefined;
			await executePromptTurn(session, ctx.clientState, prompt, [], streaming);
			reportQueuedPrompts(ctx.socket, ctx.clientState);
		}
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "COMMAND_FAILED", error);
	}
};

export const commandsActionHandlers: ActionHandlersMap = {
	ListCommands: handleListCommands as ActionHandler<never>,
	RunCommand: handleRunCommand as ActionHandler<never>,
};
