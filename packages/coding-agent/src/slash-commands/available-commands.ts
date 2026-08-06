import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { Model } from "@veyyon/ai";
import type { SkillsSettings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import { getSkillSlashCommandName, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { thinkingLevelArgHint } from "../thinking";
import {
	ACP_BUILTIN_RESERVED_NAMES,
	isAcpBuiltinShadowedName,
	TEXT_MODE_BUILTIN_DECLARATIONS,
} from "./text-mode-builtins";

export type AvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export interface InternalAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface AvailableCommandsSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly mcpPromptCommands?: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
	/** Active model, read only to derive the `/thinking` argument hint from the catalog row. */
	readonly model?: Model;
	setSlashCommands(slashCommands: FileSlashCommand[]): void;
	sessionManager: { getCwd(): string };
}

export async function buildAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd => loadSlashCommands({ cwd }),
): Promise<InternalAvailableSlashCommand[]> {
	const commands: InternalAvailableSlashCommand[] = [];
	const seenNames = new Set<string>();
	const appendCommand = (command: InternalAvailableSlashCommand): void => {
		if (seenNames.has(command.name)) return;
		seenNames.add(command.name);
		commands.push(command);
	};

	// The builtins come from their DECLARATIONS, not from the assembled registry. Every field read
	// here is metadata, and the one runtime question, "can a text client drive this", is declared as
	// `textMode` and type-checked against the handler table. Reading it off `command.handle` instead
	// cost this module 959 modules, the whole application behind 67 handler bodies.
	for (const declaration of TEXT_MODE_BUILTIN_DECLARATIONS) {
		// `/thinking`'s accepted values are per-model (the catalog row's
		// declared levels), so its hint is derived from the session's active
		// model rather than declared statically.
		const hint =
			declaration.name === "thinking"
				? (thinkingLevelArgHint(session.model) ?? declaration.acpInputHint)
				: (declaration.acpInputHint ?? declaration.inlineHint);
		appendCommand({
			name: declaration.name,
			aliases: declaration.aliases ? [...declaration.aliases] : undefined,
			description: declaration.acpDescription ?? declaration.description,
			input: hint ? { hint } : undefined,
			subcommands: declaration.subcommands?.map(sub => ({ ...sub })),
			source: "builtin",
		});
	}

	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			appendCommand({
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				input: { hint: "arguments" },
				source: "skill",
			});
		}
	}

	const runner = session.extensionRunner;
	if (runner) {
		for (const command of runner.getRegisteredCommands(ACP_BUILTIN_RESERVED_NAMES)) {
			if (isAcpBuiltinShadowedName(command.name)) continue;
			appendCommand({
				name: command.name,
				description: command.description ?? "(extension command)",
				input: { hint: "arguments" },
				source: "extension",
			});
		}
	}

	for (const command of session.customCommands) {
		const source: AvailableSlashCommandSource = command.path?.startsWith("mcp:") ? "mcp_prompt" : "custom";
		appendCommand({
			name: command.command.name,
			description: command.command.description,
			input: { hint: "arguments" },
			source,
		});
	}

	const fileCommands = await loadFileCommands(session.sessionManager.getCwd());
	session.setSlashCommands(fileCommands);
	for (const command of fileCommands) {
		appendCommand({ name: command.name, description: command.description, source: "file" });
	}

	return commands;
}

export function toAcpAvailableCommands(commands: readonly InternalAvailableSlashCommand[]): AvailableCommand[] {
	return commands.map(command => ({
		name: command.name,
		description: command.description ?? "",
		input: command.input,
	}));
}
