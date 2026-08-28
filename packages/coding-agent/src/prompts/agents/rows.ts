/** The `agents/` prompt rows: the bundled agent definitions. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import agentsDeep from "./deep.md" with { type: "text" };
import agentsDesigner from "./designer.md" with { type: "text" };
import agentsFrontmatter from "./frontmatter.md" with { type: "text" };
import agentsInit from "./init.md" with { type: "text" };
import agentsLibrarian from "./librarian.md" with { type: "text" };
import agentsReviewer from "./reviewer.md" with { type: "text" };
import agentsScout from "./scout.md" with { type: "text" };
import agentsSonic from "./sonic.md" with { type: "text" };

/** Every prompt under `src/prompts/agents/`, keyed by its id (the path under `src/prompts/`). */
export const agentsPrompts = definePromptRows({
	"agents/deep": { text: agentsDeep, purpose: "the bundled end-to-end worker agent definition" },
	"agents/designer": { text: agentsDesigner, purpose: "the bundled designer agent definition" },
	"agents/frontmatter": { text: agentsFrontmatter, purpose: "renders an agent definition back out as frontmatter" },
	"agents/init": { text: agentsInit, purpose: "the bundled init agent that writes AGENTS.md" },
	"agents/librarian": { text: agentsLibrarian, purpose: "the bundled librarian agent definition" },
	"agents/reviewer": { text: agentsReviewer, purpose: "the bundled reviewer agent definition" },
	"agents/scout": { text: agentsScout, purpose: "the bundled scout agent definition" },
	"agents/sonic": { text: agentsSonic, purpose: "the bundled contained-change worker agent definition" },
} satisfies Record<string, PromptEntry>);
