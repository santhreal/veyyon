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

export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

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
	return rendered.definitions ? `${rendered.definitions}\n\n${envelope}` : envelope;
});

const INLINE_ARG_SHELL_PATTERN = /\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|\d+)/;
const INLINE_ARG_TEMPLATE_PATTERN = /\{\{[\s\S]*?(?:\b(?:arguments|ARGUMENTS|args)\b|\barg\s+[^}]+)[\s\S]*?\}\}/;

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

					const entryDir = entry.includes("/") ? entry.split("/").slice(0, -1).join(":") : "";
					const fullSubdir = subdir && entryDir ? `${subdir}:${entryDir}` : entryDir || subdir;

					let sourceStr: string;
					if (source === "user") {
						sourceStr = fullSubdir ? `(user:${fullSubdir})` : "(user)";
					} else {
						sourceStr = fullSubdir ? `(project:${fullSubdir})` : "(project)";
					}

					let description = String(frontmatter.description || "");
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) description += "...";
						}
					}

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
	cwd?: string;
	agentDir?: string;
}

export async function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();

	const templates: PromptTemplate[] = [];

	const globalPromptsDir = options.agentDir ? path.join(options.agentDir, "prompts") : resolvedAgentDir;
	const globalTemplates = await loadTemplatesFromDir(globalPromptsDir, "user");
	for (let ti = 0; ti < globalTemplates.length; ti++) templates.push(globalTemplates[ti]!);

	const projectPromptsDir = getProjectPromptsDir(resolvedCwd);
	const projectTemplates = await loadTemplatesFromDir(projectPromptsDir, "project");
	for (let ti = 0; ti < projectTemplates.length; ti++) templates.push(projectTemplates[ti]!);

	return templates;
}

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
