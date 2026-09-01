import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface SlashCommand {
	name: string;
	path: string;
	content: string;
	level: "user" | "project" | "native";
	_source: SourceMeta;
}

export const slashCommandCapability = defineCapability<SlashCommand>({
	id: "slash-commands",
	displayName: "Slash Commands",
	description: "Custom slash commands defined as markdown files",
	key: cmd => cmd.name,
	toExtensionId: cmd => `slash-command:${cmd.name}`,
	validate: cmd => {
		if (!cmd.name) return "Missing name";
		if (!cmd.path) return "Missing path";
		if (cmd.content === undefined) return "Missing content";
		if (cmd.level !== "user" && cmd.level !== "project" && cmd.level !== "native") {
			return "Invalid level: must be 'user', 'project', or 'native'";
		}
		return undefined;
	},
});
