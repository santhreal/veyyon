/** Helper for wiring the `getCommands` action of {@link ExtensionAPI}. Centralizes the union over the three slash-command sources the runtime */
import type { SkillsSettings } from "../../config/settings";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "../../slash-commands/builtin-declarations";
import type { CustomCommandSource, LoadedCustomCommand } from "../custom-commands";
import { getSkillSlashCommandName, type Skill } from "../skills";
import type { SlashCommandInfo, SlashCommandLocation } from "../slash-commands";
import type { ExtensionRunner } from "./runner";

interface CommandsCapableSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
}

export function getSessionSlashCommands(session: CommandsCapableSession): SlashCommandInfo[] {
	const out: SlashCommandInfo[] = [];

	const runner = session.extensionRunner;
	if (runner) {
		for (const cmd of runner.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES)) {
			out.push({
				name: cmd.name,
				description: cmd.description,
				source: "extension",
			});
		}
	}

	for (const cmd of session.customCommands) {
		out.push({
			name: cmd.command.name,
			description: cmd.command.description,
			source: "prompt",
			location: customCommandLocation(cmd.source),
			path: cmd.resolvedPath,
		});
	}

	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			out.push({
				name: getSkillSlashCommandName(skill),
				description: skill.description || undefined,
				source: "skill",
				path: skill.filePath,
			});
		}
	}

	return out;
}

function customCommandLocation(source: CustomCommandSource): SlashCommandLocation | undefined {
	switch (source) {
		case "user":
			return "user";
		case "project":
			return "project";
		case "bundled":
			return undefined;
	}
}
