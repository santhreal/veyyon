import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";

const cwd = process.cwd();
const workspaceTree = {
	rootPath: cwd,
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};
const authorityStatement =
	"The current user message has highest authority. The user-authored context files below are next: they override conflicting Veyyon system/developer prompt defaults and any other supplied or historical context. Among these files, later and deeper files override earlier and broader files. You MUST follow the resulting instructions for all tasks:";

type ContextFile = { path: string; content: string; depth?: number };

async function renderProjectPrompt(
	contextFiles: ContextFile[],
	mode: "custom" | "default" = "custom",
): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd,
		...(mode === "custom" ? { resolvedCustomPrompt: "Context authority regression prompt." } : {}),
		contextFiles,
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree,
		activeRepoContext: null,
	});
	return systemPrompt.join("\n\n");
}

describe("context-file authority", () => {
	/**
	 * User-authored standing instructions must outrank Veyyon's generic workflow
	 * defaults, while the user's current request remains the active authority.
	 */
	it("states the user-controlled precedence before loaded instructions in both prompt modes", async () => {
		const filePath = "/repo/AGENTS.md";
		const fileContent = "Use the repository's release workflow.";
		const contextFiles = [{ path: filePath, content: fileContent, depth: 0 }];
		const renderedPrompts = await Promise.all([
			renderProjectPrompt(contextFiles, "default"),
			renderProjectPrompt(contextFiles, "custom"),
		]);

		for (const rendered of renderedPrompts) {
			const authorityIndex = rendered.indexOf(authorityStatement);
			const fileIndex = rendered.indexOf(`<file path="${filePath}">\n${fileContent}\n</file>`);
			expect(authorityIndex).toBeGreaterThanOrEqual(0);
			expect(fileIndex).toBeGreaterThan(authorityIndex);
		}
	});

	/**
	 * Conflicting broad and specific files need an explicit deterministic winner;
	 * otherwise a model may follow the global default instead of the project rule.
	 */
	it("declares later deeper files authoritative over earlier broader files", async () => {
		const rendered = await renderProjectPrompt([
			{ path: "/repo/AGENTS.md", content: "Run the broad workflow.", depth: 2 },
			{ path: "/repo/pkg/AGENTS.md", content: "Run the package workflow.", depth: 0 },
		]);

		expect(rendered).toContain(authorityStatement);
		expect(rendered.indexOf("Run the package workflow.")).toBeGreaterThan(
			rendered.indexOf("Run the broad workflow."),
		);
	});

	/**
	 * Sessions with no loaded context files must not claim that absent user-authored
	 * instructions override the prompt or perturb the stable project-prompt bytes.
	 */
	it("omits the authority statement when no context file is loaded", async () => {
		const rendered = await renderProjectPrompt([]);

		expect(rendered).not.toContain(authorityStatement);
		expect(rendered).not.toContain("<context>");
	});
});
