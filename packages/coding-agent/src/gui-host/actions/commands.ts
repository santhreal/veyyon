import { errorMessage } from "@veyyon/utils";
import { reset as resetCapabilities } from "../../discovery/capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { runSkillCommand } from "../../slash-commands/skill-dispatch";
import { appendCommandOutput } from "../command-output";
import { buildCommandsView } from "../commands-view";
import { isDesktopHostCommand } from "../desktop-commands";
import { publishModelsView } from "../models-view";
import { reportQueuedPrompts } from "../queued-prompts";
import { executePromptTurn, getOrCreateAgentSession } from "../turns";
import { activateSession, emitActiveSession, replyError } from "./active-session";
import { runDesktopHostCommand } from "./host-commands";
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
	const parsed = parseSlashCommand(text);
	if (!parsed) {
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

		// A command this host answers is answered before the builtin table,
		// which holds the text-mode set and does not know this one. Its name
		// is a builtin's, so a skill still cannot shadow it.
		if (isDesktopHostCommand(parsed.name)) {
			await runDesktopHostCommand(ctx, session, parsed.name, parsed.args);
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
