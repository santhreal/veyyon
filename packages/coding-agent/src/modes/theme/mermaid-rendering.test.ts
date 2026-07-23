import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { Settings } from "../../config/settings";
import { buildSystemPrompt } from "../../system-prompt";
import { getMarkdownTheme, getThemeByName, setMarkdownMermaidRendering, setThemeInstance } from "./theme";

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	setMarkdownMermaidRendering(true);
});

describe("Mermaid rendering setting", () => {
	it("removes the Mermaid prompt note when rendering is disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			renderMermaid: false,
			contextFiles: [],
			skills: [],
			toolNames: [],
			workspaceTree,
		});

		expect(systemPrompt.join("\n")).not.toContain("```mermaid");
	});

	/** With rendering off, the diagram source must display as a normal code
	 * block in the SHIPPED fence dress: the `──╴mermaid` opening rule carrying
	 * the language tag and a bare closing rule, never literal ``` markers
	 * (those read as unrendered markdown). The body stays verbatim source. */
	it("falls back to a highlighted code fence when rendering is disabled", () => {
		setMarkdownMermaidRendering(false);

		const markdown = new Markdown("```mermaid\ngraph TD\n  A --> B\n```", 0, 0, getMarkdownTheme());
		const lines = stripAnsi(markdown.render(80).join("\n"));

		expect(lines).toContain("──╴mermaid");
		expect(lines).toContain("graph TD");
		expect(lines).toContain("-->");
		expect(lines).not.toContain("```");
	});
});
