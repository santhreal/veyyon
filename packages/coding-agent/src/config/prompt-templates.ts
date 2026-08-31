import * as fs from "node:fs";
import * as path from "node:path";
import {
	errorMessage,
	getProjectDir,
	getProjectPromptsDir,
	getPromptsDir,
	logger,
	parseFrontmatter,
	prompt,
} from "@veyyon/utils";
import { jtdToTypeScript, jtdToTypeScriptParts } from "../tools/jtd-to-typescript";
import { parseCommandArgs, substituteArgs } from "../utils/command-args";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

/**
 * Report an output schema that could not be rendered into a prompt.
 *
 * Substituting `unknown` is not a graceful degrade, which is why this exists
 * rather than a bare catch in each helper. The rendered type is what tells the
 * model the exact shape it must submit; with `unknown` in its place the model
 * has nothing to pattern-match on, returns an arbitrary shape, and fails output
 * validation over and over. That is precisely the failure `renderYieldSchema`
 * exists to prevent, so reintroducing it silently while the operator watches a
 * subagent loop is the worst case (Law 10).
 *
 * A self-referential schema is NOT this case: the renderer expands it into a
 * named interface. What reaches here is a schema nested past the renderer's
 * depth ceiling. A schema that is merely empty or not an object renders as
 * `unknown` WITHOUT throwing, which is a legitimate degenerate result rather
 * than a failure, so it correctly reports nothing.
 */
function reportUnrenderableSchema(error: unknown): void {
	logger.warn("A subagent output schema could not be rendered, so the model is not being told what shape to return", {
		error: errorMessage(error),
		fix: "Flatten the schema, or describe the deeply nested part as a string. Until then the subagent will keep failing output validation.",
	});
}

prompt.registerHelper("jtdToTypeScript", (schema: unknown): string => {
	try {
		return jtdToTypeScript(schema);
	} catch (error) {
		reportUnrenderableSchema(error);
		return "unknown";
	}
});

/**
 * Render a subagent output schema wrapped in the `yield` tool's
 * `result: { data: … }` envelope so the model sees the shape it must
 * actually submit, not just the user-facing payload. Without this the LLM
 * pattern-matches on the bare interface and puts strings/objects directly
 * in `result.data`, tripping schema validation repeatedly.
 */
prompt.registerHelper("renderYieldSchema", (schema: unknown): string => {
	let rendered: { definitions: string; type: string };
	try {
		rendered = jtdToTypeScriptParts(schema);
	} catch (error) {
		reportUnrenderableSchema(error);
		rendered = { definitions: "", type: "unknown" };
	}
	const lines = rendered.type.split("\n");
	const [first, ...rest] = lines;
	const body = rest.length === 0 ? first : `${first}\n${rest.map(l => `  ${l}`).join("\n")}`;
	const envelope = `result: {\n  data: ${body};\n}`;
	// Interface declarations go BEFORE the envelope, never inside it: a
	// self-referential schema renders as a named interface plus a reference, and
	// putting the declaration in type position would teach the model syntax that
	// does not parse.
	return rendered.definitions ? `${rendered.definitions}\n\n${envelope}` : envelope;
});

const INLINE_ARG_SHELL_PATTERN = /\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|\d+)/;
const INLINE_ARG_TEMPLATE_PATTERN = /\{\{[\s\S]*?(?:\b(?:arguments|ARGUMENTS|args)\b|\barg\s+[^}]+)[\s\S]*?\}\}/;

/**
 * Keep the check source-level and cheap: if the template text contains any explicit
 * inline-arg placeholder syntax, do not append the fallback text again.
 */
export function templateUsesInlineArgPlaceholders(templateSource: string): boolean {
	return INLINE_ARG_SHELL_PATTERN.test(templateSource) || INLINE_ARG_TEMPLATE_PATTERN.test(templateSource);
}

export function appendInlineArgsFallback(
	rendered: string,
	argsText: string,
	usesInlineArgPlaceholders: boolean,
): string {
	if (argsText.length === 0 || usesInlineArgPlaceholders) return rendered;
	if (rendered.length === 0) return argsText;

	return `${rendered}\n\n${argsText}`;
}

/**
 * Recursively scan a directory for .md files (and symlinks to .md files) and load them as prompt templates
 */
async function loadTemplatesFromDir(
	dir: string,
	source: "user" | "project",
	subdir: string = "",
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	try {
		const glob = new Bun.Glob("**/*");
		const entries = [];
		for await (const entry of glob.scan({ cwd: dir, absolute: false, onlyFiles: false })) {
			entries.push(entry);
		}

		// Group by path depth to process directories before deeply nested files
		entries.sort((a, b) => a.split("/").length - b.split("/").length);

		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			const file = Bun.file(fullPath);

			try {
				const stat = await file.exists();
				if (!stat) continue;

				if (entry.endsWith(".md")) {
					const rawContent = await file.text();
					const { frontmatter, body } = parseFrontmatter(rawContent, { source: fullPath });

					const name = entry.split("/").pop()!.slice(0, -3); // Remove .md extension

					// Build source string based on subdirectory structure
					const entryDir = entry.includes("/") ? entry.split("/").slice(0, -1).join(":") : "";
					const fullSubdir = subdir && entryDir ? `${subdir}:${entryDir}` : entryDir || subdir;

					let sourceStr: string;
					if (source === "user") {
						sourceStr = fullSubdir ? `(user:${fullSubdir})` : "(user)";
					} else {
						sourceStr = fullSubdir ? `(project:${fullSubdir})` : "(project)";
					}

					// Get description from frontmatter or first non-empty line
					let description = String(frontmatter.description || "");
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							// Truncate if too long
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) description += "...";
						}
					}

					// Append source to description
					description = description ? `${description} ${sourceStr}` : sourceStr;

					templates.push({
						name,
						description,
						content: body,
						source: sourceStr,
					});
				}
			} catch (error) {
				logger.warn("Failed to load prompt template", { path: fullPath, error: String(error) });
			}
		}
	} catch (error) {
		if (!fs.existsSync(dir)) {
			return [];
		}
		logger.warn("Failed to scan prompt templates directory", { dir, error: String(error) });
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/.veyyon/prompts/
 */
export async function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();

	const templates: PromptTemplate[] = [];

	// 1. Load global templates from agentDir/prompts/
	// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
	const globalPromptsDir = options.agentDir ? path.join(options.agentDir, "prompts") : resolvedAgentDir;
	templates.push(...(await loadTemplatesFromDir(globalPromptsDir, "user")));

	// 2. Load project templates from cwd/.veyyon/prompts/
	const projectPromptsDir = getProjectPromptsDir(resolvedCwd);
	templates.push(...(await loadTemplatesFromDir(projectPromptsDir, "project")));

	return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find(t => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const usesInlineArgPlaceholders = templateUsesInlineArgPlaceholders(template.content);
		const substituted = substituteArgs(template.content, args);
		const rendered = prompt.render(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
		return appendInlineArgsFallback(rendered, argsText, usesInlineArgPlaceholders);
	}

	return text;
}
