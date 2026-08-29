import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { Effort } from "@veyyon/catalog/effort";
import { prompt } from "@veyyon/utils";
import { agentsPrompts } from "../prompts/agents/rows";

export interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
}

export interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

export function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = prompt.render(def.template);
	if (!def.frontmatter) return body;
	return prompt.render(agentsPrompts["agents/frontmatter"].text, { ...def.frontmatter, body });
}

export const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "scout.md", template: agentsPrompts["agents/scout"].text },
	{ fileName: "designer.md", template: agentsPrompts["agents/designer"].text },
	{ fileName: "reviewer.md", template: agentsPrompts["agents/reviewer"].text },
	{ fileName: "librarian.md", template: agentsPrompts["agents/librarian"].text },
	{
		fileName: "deep.md",
		frontmatter: {
			name: "deep",
			description:
				"Vague outcome, multi-step, owned end to end: works out what to change, changes it, tests it, and reviews its own work before returning. Scale it can carry: building a whole package from nothing. The most expensive lane, so do not reach for it when the outcome is already clear.",
			spawns: "*",
			thinkingLevel: ThinkingLevel.Inherit,
		},
		template: agentsPrompts["agents/deep"].text,
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
