/**
 * The `agents/` prompt rows: the bundled agent definitions.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
 * paid 167 modules for it, the largest single edge that file had. A consumer now imports the directory it
 * belongs to and pays for that directory.
 *
 * THE INVARIANT IS UNCHANGED AND IS CHECKED ONE LEVEL DEEPER. Every `.md` under `src/prompts/` is imported by
 * exactly one row module, every row module is aggregated by `registry.ts`, and nothing else in the repository
 * may import a `.md`. `packages/coding-agent/test/core/prompt-registry-coverage.test.ts` pins all three, so a
 * new prompt is still unreachable code until it is registered, and a row still cannot describe a file that is
 * not there.
 *
 * DO NOT re-declare a row that another module already holds. The id-to-file mapping exists exactly once, here
 * for these ids, and the coverage suite fails on a second importer.
 */

import type { PromptEntry } from "@veyyon/utils/prompt-registry";

import agentsDesigner from "./designer.md" with { type: "text" };
import agentsFrontmatter from "./frontmatter.md" with { type: "text" };
import agentsInit from "./init.md" with { type: "text" };
import agentsLibrarian from "./librarian.md" with { type: "text" };
import agentsReviewer from "./reviewer.md" with { type: "text" };
import agentsScout from "./scout.md" with { type: "text" };
import agentsSonic from "./sonic.md" with { type: "text" };
import agentsTask from "./task.md" with { type: "text" };

/** Every prompt under `src/prompts/agents/`, keyed by its id (the path under `src/prompts/`). */
export const agentsPrompts = {
	"agents/designer": { text: agentsDesigner, purpose: "the bundled designer agent definition" },
	"agents/frontmatter": { text: agentsFrontmatter, purpose: "renders an agent definition back out as frontmatter" },
	"agents/init": { text: agentsInit, purpose: "the bundled init agent that writes AGENTS.md" },
	"agents/librarian": { text: agentsLibrarian, purpose: "the bundled librarian agent definition" },
	"agents/reviewer": { text: agentsReviewer, purpose: "the bundled reviewer agent definition" },
	"agents/scout": { text: agentsScout, purpose: "the bundled scout agent definition" },
	"agents/sonic": { text: agentsSonic, purpose: "the bundled contained-change worker agent definition" },
	"agents/task": { text: agentsTask, purpose: "the bundled end-to-end worker agent definition" },
} satisfies Record<string, PromptEntry>;
