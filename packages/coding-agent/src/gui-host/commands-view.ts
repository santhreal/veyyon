import type { Socket } from "node:net";
import { logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import {
	type AvailableSlashCommandSource,
	buildAvailableSlashCommands,
	type InternalAvailableSlashCommand,
} from "../slash-commands/available-commands";
import { TEXT_MODE_BUILTIN_DECLARATIONS } from "../slash-commands/text-mode-builtins";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";
import type { CommandSource, CommandSubcommandView, CommandView } from "./wire";

const SOURCES: Record<AvailableSlashCommandSource, CommandSource> = {
	builtin: "Builtin",
	skill: "Skill",
	extension: "Extension",
	custom: "Custom",
	mcp_prompt: "McpPrompt",
	file: "File",
};

function toView(command: InternalAvailableSlashCommand): CommandView {
	const subcommands: CommandSubcommandView[] = (command.subcommands ?? []).map(sub => ({
		name: sub.name,
		description: sub.description ?? null,
		usage: sub.usage ?? null,
	}));
	return {
		name: command.name,
		aliases: command.aliases ?? [],
		description: command.description ?? null,
		input_hint: command.input?.hint ?? null,
		source: SOURCES[command.source],
		subcommands,
	};
}

/**
 * The commands a client can run before any session exists.
 *
 * Skills, extension contributions, project command files and MCP prompts are
 * all read off a live session, and the host creates one lazily: it opens on
 * the first prompt, not on the handshake. A palette opened before that still
 * lists the builtins, which are declared rather than discovered, and the full
 * catalogue replaces it the moment a session is created.
 */
export function builtinCommandViews(): CommandView[] {
	return TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => {
		const hint = declaration.acpInputHint ?? declaration.inlineHint;
		return toView({
			name: declaration.name,
			aliases: declaration.aliases ? Array.from(declaration.aliases) : undefined,
			description: declaration.acpDescription ?? declaration.description,
			input: hint ? { hint } : undefined,
			subcommands: declaration.subcommands?.map(sub => ({ ...sub })),
			source: "builtin",
		});
	});
}

/**
 * Every command the host will run for `state`: the builtins plus whatever the
 * workspace installed, when a session is there to read them off.
 */
export async function buildCommandsView(state: ClientSessionState): Promise<CommandView[]> {
	const session = state.agentSession;
	if (!session) return builtinCommandViews();
	const commands = await buildAvailableSlashCommands(session);
	return commands.map(toView);
}

/** State the command catalogue to one client, without a request to answer. */
export async function publishCommandsView(socket: Socket, state: ClientSessionState): Promise<void> {
	try {
		const commands = await buildCommandsView(state);
		writeFrame(socket, { Snapshot: { Commands: commands } });
	} catch (error) {
		logger.error("GUI host command catalogue failed", { error });
	}
}

/**
 * Re-state the catalogue whenever the session's command metadata changes: an
 * extension registering a command, a plugin reload, a project switch. The
 * subscription is dropped with the session it was taken on.
 */
export function watchCommandMetadata(socket: Socket, state: ClientSessionState, session: AgentSession): () => void {
	return session.subscribeCommandMetadataChanged(() => {
		void publishCommandsView(socket, state);
	});
}
