/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
// The effort ladder from its owner (`@veyyon/catalog/effort`, 1 module) rather than the
// `@veyyon/ai` barrel that re-exports it (346).
import { Effort } from "@veyyon/catalog/effort";
import { parseFrontmatter, prompt } from "@veyyon/utils";
import { parseAgentFields } from "../discovery/helpers";
import { agentsPrompts } from "../prompts/agents/rows";
// Embed agent markdown files at build time

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = prompt.render(def.template);
	if (!def.frontmatter) return body;
	return prompt.render(agentsPrompts["agents/frontmatter"].text, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "scout.md", template: agentsPrompts["agents/scout"].text },
	{ fileName: "designer.md", template: agentsPrompts["agents/designer"].text },
	{ fileName: "reviewer.md", template: agentsPrompts["agents/reviewer"].text },
	{ fileName: "librarian.md", template: agentsPrompts["agents/librarian"].text },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description:
				"Vague outcome, multi-step, owned end to end: works out what to change, changes it, tests it, and reviews its own work before returning. Scale it can carry: building a whole package from nothing. The most expensive lane, so do not reach for it when the outcome is already clear.",
			spawns: "*",
			thinkingLevel: ThinkingLevel.Inherit,
		},
		template: agentsPrompts["agents/task"].text,
	},
	{
		fileName: "sonic.md",
		frontmatter: {
			name: "sonic",
			description:
				"Clear outcome, contained change: you know what needs to happen, even if some details still need working out. It may look things up and ask back when something is ambiguous. The cheapest lane. Not for sprawling work that has to be discovered, built and verified in stages.",
			thinkingLevel: Effort.Medium,
		},
		template: agentsPrompts["agents/sonic"].text,
	},
];

// Computed lazily on first loadBundledAgents() call to avoid eager prompt.render at module load.

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/**
 * Parse an agent from embedded content.
 */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}
	bundledAgentsCache = EMBEDDED_AGENT_DEFS.map(def =>
		parseAgent(`embedded:${def.fileName}`, buildAgentContent(def), "bundled"),
	);
	return bundledAgentsCache;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find(a => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
 */
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
