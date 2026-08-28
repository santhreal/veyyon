import * as path from "node:path";
import { parseFrontmatter, prompt } from "@veyyon/utils";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { loadCapability } from "../discovery";
import { agentsPrompts } from "../prompts/agents/rows";

const EMBEDDED_COMMANDS: { name: string; content: string }[] = [
	{ name: "init.md", content: prompt.render(agentsPrompts["agents/init"].text) },
];

export const EMBEDDED_COMMAND_TEMPLATES: ReadonlyArray<{ name: string; content: string }> = EMBEDDED_COMMANDS;

export interface WorkflowCommand {
	name: string;
	description: string;
	instructions: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

function getString(frontmatter: Record<string, unknown>, key: string): string {
	const value = frontmatter[key];
	return typeof value === "string" ? value : "";
}

let bundledCommandsCache: WorkflowCommand[] | null = null;

export function loadBundledCommands(): WorkflowCommand[] {
	if (bundledCommandsCache !== null) {
		return bundledCommandsCache;
	}

	const commands: WorkflowCommand[] = [];

	for (const { name, content } of EMBEDDED_COMMANDS) {
		const { frontmatter, body } = parseFrontmatter(content, {
			source: `embedded:${name}`,
			level: "fatal",
		});
		const cmdName = name.replace(/\.md$/, "");

		commands.push({
			name: cmdName,
			description: getString(frontmatter, "description"),
			instructions: body,
			source: "bundled",
			filePath: `embedded:${name}`,
		});
	}

	bundledCommandsCache = commands;
	return commands;
}

export async function discoverCommands(cwd: string, agentDir?: string): Promise<WorkflowCommand[]> {
	const resolvedCwd = path.resolve(cwd);

	const result = await loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: resolvedCwd, agentDir });

	const commands: WorkflowCommand[] = [];
	const seen = new Set<string>();

	for (const cmd of result.items) {
		if (seen.has(cmd.name)) continue;

		const { frontmatter, body } = parseFrontmatter(cmd.content, {
			source: cmd.path ?? `workflow-command:${cmd.name}`,
			level: cmd.level === "native" ? "fatal" : "warn",
		});

		const source: "bundled" | "user" | "project" = cmd.level === "native" ? "bundled" : cmd.level;

		commands.push({
			name: cmd.name,
			description: getString(frontmatter, "description"),
			instructions: body,
			source,
			filePath: cmd.path,
		});
		seen.add(cmd.name);
	}

	for (const cmd of loadBundledCommands()) {
		if (seen.has(cmd.name)) continue;
		commands.push(cmd);
		seen.add(cmd.name);
	}

	return commands;
}

export function getCommand(commands: WorkflowCommand[], name: string): WorkflowCommand | undefined {
	return commands.find(c => c.name === name);
}

export function expandCommand(command: WorkflowCommand, input: string): string {
	return command.instructions.replace(/\$@/g, () => input);
}

export function clearBundledCommandsCache(): void {
	bundledCommandsCache = null;
}
