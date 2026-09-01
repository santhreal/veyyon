import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface Instruction {
	name: string;
	path: string;
	content: string;
	applyTo?: string;
	_source: SourceMeta;
}

export const instructionCapability = defineCapability<Instruction>({
	id: "instructions",
	displayName: "Instructions",
	description: "File-specific instructions with glob pattern matching (GitHub Copilot format)",
	key: inst => inst.name,
	toExtensionId: inst => `instruction:${inst.name}`,
	validate: inst => {
		if (!inst.name) return "Missing name";
		if (!inst.path) return "Missing path";
		if (inst.content === undefined) return "Missing content";
		return undefined;
	},
});
