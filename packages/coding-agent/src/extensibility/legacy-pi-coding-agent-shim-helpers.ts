import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import { Text } from "@veyyon/tui";
import {
	errorMessage,
	escapeRegExp,
	getAgentDir,
	getProjectDir,
	parseFrontmatter as parseOmpFrontmatter,
} from "@veyyon/utils";
import type { PromptTemplate } from "../config/prompt-templates";
import { type SettingPath, Settings } from "../config/settings";
import { EditTool } from "../edit";
import { formatExitCodeNotice } from "../exec/exit-notice";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, LoadExtensionsResult } from "../sdk";
import {
	discoverContextFiles,
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	discoverSkills,
	createAgentSession as ompCreateAgentSession,
} from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "../session/streaming-output";
import type { Tool, ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { ReadTool } from "../tools/read";
import { formatBytes } from "../tools/render-utils";
import { WriteTool } from "../tools/write";
import { EventBus } from "../utils/event-bus";
import { loadExtensionFromFactory, loadExtensions } from "./extensions";
import { ExtensionRuntime } from "./extensions/loader";
import type { ExtensionFactory, ToolDefinition } from "./extensions/types";
import { LEGACY_TOOL_DEFINITION_MARKER } from "./legacy-tool-marker";
import type { Skill } from "./skills";
import { loadSkillsFromDir } from "./skills";
import { Type } from "./typebox";

import {
	LEGACY_CODING_TOOL_NAMES,
	LEGACY_READ_ONLY_TOOL_NAMES,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	legacyBuiltinTool,
	parseFrontmatter,
} from "./legacy-pi-coding-agent-shim";

export function createCodingTools(cwd: string): ToolDefinition[] {
	return LEGACY_CODING_TOOL_NAMES.map(name => legacyBuiltinTool(cwd, name));
}

export function createReadOnlyTools(cwd: string): ToolDefinition[] {
	return LEGACY_READ_ONLY_TOOL_NAMES.map(name => {
		if (name === "read") return createReadTool(cwd);
		if (name === "grep") return createGrepTool(cwd);
		if (name === "find") return createFindTool(cwd);
		return createLsTool(cwd);
	});
}

export const SettingsManager = {
	create(cwd: string, agentDir?: string): Promise<Settings> {
		return Settings.init({ cwd, agentDir });
	},

	inMemory(): Settings {
		return Settings.isolated();
	},
} as const;

export type ResourceDiagnostic = {
	type: "error" | "warning" | "info";
	message: string;
	path?: string;
};

export interface AgentsFile {
	path: string;
	content: string;
}

export interface Theme {
	name: string;
}

export interface DefaultResourceLoaderOptions {
	cwd?: string;
	agentDir?: string;
	settingsManager?: Settings | Promise<Settings>;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string | string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: AgentsFile[] }) => { agentsFiles: AgentsFile[] };
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: AgentsFile[] };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	reload(): Promise<void>;
	readonly __veyyonLegacyPiLoader?: true;
}

interface ResolvedLoaderState {
	cwd: string;
	agentDir: string;
	settingsPromise?: Promise<Settings>;
	eventBus: EventBus;
	extensionFactories: ExtensionFactory[];
	noExtensions: boolean;
	additionalExtensionPaths: string[];
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
}

interface AdditionalSkillLoadResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

interface AdditionalPromptLoadResult {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export class DefaultResourceLoader implements ResourceLoader {
	readonly __veyyonLegacyPiLoader = true as const;
	#state: ResolvedLoaderState;
	#options: DefaultResourceLoaderOptions;
	#extensionsResult: LoadExtensionsResult = {
		extensions: [],
		errors: [],
		withheld: [],
		runtime: new ExtensionRuntime(),
	};
	#skills: Skill[] = [];
	#skillDiagnostics: ResourceDiagnostic[] = [];
	#prompts: PromptTemplate[] = [];
	#promptDiagnostics: ResourceDiagnostic[] = [];
	#themes: Theme[] = [];
	#themeDiagnostics: ResourceDiagnostic[] = [];
	#agentsFiles: AgentsFile[] = [];
	#systemPrompt: string | undefined;
	#appendSystemPrompt: string[] = [];
	#loaded = false;

	constructor(options: DefaultResourceLoaderOptions = {}) {
		this.#options = options;
		const cwd = options.cwd ?? getProjectDir();
		const agentDir = options.agentDir ?? getAgentDir();
		this.#state = {
			cwd,
			agentDir,
			settingsPromise: options.settingsManager ? Promise.resolve(options.settingsManager) : undefined,
			eventBus: options.eventBus ?? new EventBus(),
			extensionFactories: options.extensionFactories ?? [],
			noExtensions: options.noExtensions ?? false,
			additionalExtensionPaths: options.additionalExtensionPaths ?? [],
			additionalSkillPaths: options.additionalSkillPaths ?? [],
			additionalPromptTemplatePaths: options.additionalPromptTemplatePaths ?? [],
		};
	}

	getExtensions(): LoadExtensionsResult {
		return this.#extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.#skills, diagnostics: this.#skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.#prompts, diagnostics: this.#promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.#themes, diagnostics: this.#themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: AgentsFile[] } {
		return { agentsFiles: this.#agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.#systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.#appendSystemPrompt;
	}

	async reload(): Promise<void> {
		const { cwd, agentDir } = this.#state;
		const options = this.#options;

		let settingsPromise = this.#state.settingsPromise;
		if (!settingsPromise) {
			settingsPromise = Settings.init({ cwd, agentDir });
			this.#state.settingsPromise = settingsPromise;
		}
		const settings = await settingsPromise;

		const [extensionsResult, skillsBase, additionalSkills, prompts, additionalPrompts, agentsFiles] =
			await Promise.all([
				this.#loadExtensions(settings),
				options.noSkills
					? Promise.resolve({ skills: [], warnings: [] })
					: discoverSkills(cwd, agentDir, {
							...settings.getGroup("skills"),
							disabledExtensions: settings.get("disabledExtensions") ?? [],
						}),
				this.#loadAdditionalSkills(),
				options.noPromptTemplates ? Promise.resolve([]) : discoverPromptTemplates(cwd, agentDir),
				this.#loadAdditionalPromptTemplates(),
				options.noContextFiles ? Promise.resolve([]) : discoverContextFiles(cwd, agentDir),
			]);

		this.#extensionsResult = options.extensionsOverride
			? options.extensionsOverride(extensionsResult)
			: extensionsResult;

		const skillsBaseResult = {
			skills: [...skillsBase.skills, ...additionalSkills.skills],
			diagnostics: [
				...skillsBase.warnings.map(w => ({
					type: "warning" as const,
					message: w.message,
					path: w.skillPath,
				})),
				...additionalSkills.diagnostics,
			],
		};
		const skillsFinal = options.skillsOverride ? options.skillsOverride(skillsBaseResult) : skillsBaseResult;
		this.#skills = skillsFinal.skills;
		this.#skillDiagnostics = skillsFinal.diagnostics;

		const promptsBase = {
			prompts: [...prompts, ...additionalPrompts.prompts],
			diagnostics: additionalPrompts.diagnostics,
		};
		const promptsFinal = options.promptsOverride ? options.promptsOverride(promptsBase) : promptsBase;
		this.#prompts = promptsFinal.prompts;
		this.#promptDiagnostics = promptsFinal.diagnostics;

		const themesBase = { themes: [] as Theme[], diagnostics: [] as ResourceDiagnostic[] };
		const themesFinal = options.themesOverride ? options.themesOverride(themesBase) : themesBase;
		this.#themes = themesFinal.themes;
		this.#themeDiagnostics = themesFinal.diagnostics;

		const agentsFilesBase = { agentsFiles };
		const agentsFilesFinal = options.agentsFilesOverride
			? options.agentsFilesOverride(agentsFilesBase)
			: agentsFilesBase;
		this.#agentsFiles = agentsFilesFinal.agentsFiles;

		const baseSystemPrompt = options.systemPrompt;
		this.#systemPrompt = options.systemPromptOverride
			? options.systemPromptOverride(baseSystemPrompt)
			: baseSystemPrompt;

		const appendSource = options.appendSystemPrompt;
		const baseAppend =
			typeof appendSource === "string" ? [appendSource] : Array.isArray(appendSource) ? appendSource : [];
		this.#appendSystemPrompt = options.appendSystemPromptOverride
			? options.appendSystemPromptOverride(baseAppend)
			: baseAppend;

		this.#loaded = true;
	}

	async #loadExtensions(settings: Settings): Promise<LoadExtensionsResult> {
		const { cwd, agentDir, noExtensions, additionalExtensionPaths, extensionFactories, eventBus } = this.#state;

		if (noExtensions && additionalExtensionPaths.length === 0 && extensionFactories.length === 0) {
			return { extensions: [], errors: [], withheld: [], runtime: new ExtensionRuntime() };
		}

		const paths = await discoverSessionExtensionPaths(
			{
				disableExtensionDiscovery: noExtensions,
				additionalExtensionPaths,
			},
			cwd,
			settings,
			agentDir,
		);

		const result = await loadExtensions(paths, cwd, eventBus, undefined, {
			agentDir,
			configuredPaths: [...additionalExtensionPaths, ...(settings.get("extensions") ?? [])],
		});
		for (let i = 0; i < extensionFactories.length; i++) {
			const loaded = await loadExtensionFromFactory(
				extensionFactories[i],
				cwd,
				eventBus,
				result.runtime,
				`<inline-loader-${i}>`,
			);
			result.extensions.push(loaded);
		}
		return result;
	}

	async #loadAdditionalSkills(): Promise<AdditionalSkillLoadResult> {
		const skills: Skill[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalSkillPaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const skillDir =
				path.basename(resolvedPath).toLowerCase() === "skill.md" ? path.dirname(resolvedPath) : resolvedPath;
			try {
				const result = await loadSkillsFromDir({
					dir: skillDir,
					source: "legacy-resource-loader",
				});
				for (let si = 0; si < result.skills.length; si++) skills.push(result.skills[si]!);
				diagnostics.push(
					...result.warnings.map(w => ({
						type: "warning" as const,
						message: w.message,
						path: w.skillPath,
					})),
				);
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to load additional skill path: ${errorMessage(err)}`,
					path: resolvedPath,
				});
			}
		}

		return { skills, diagnostics };
	}

	async #loadAdditionalPromptTemplates(): Promise<AdditionalPromptLoadResult> {
		const prompts: PromptTemplate[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalPromptTemplatePaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const files: string[] = [];
			try {
				const stat = await fs.stat(resolvedPath);
				if (stat.isDirectory()) {
					const glob = new Bun.Glob("**/*.md");
					for await (const entry of glob.scan({ cwd: resolvedPath, absolute: false, onlyFiles: true })) {
						files.push(path.join(resolvedPath, entry));
					}
					files.sort();
				} else if (resolvedPath.toLowerCase().endsWith(".md")) {
					files.push(resolvedPath);
				} else {
					diagnostics.push({
						type: "warning",
						message: "Additional prompt template path is neither a directory nor a Markdown file",
						path: resolvedPath,
					});
				}
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to inspect additional prompt template path: ${errorMessage(err)}`,
					path: resolvedPath,
				});
				continue;
			}

			for (const filePath of files) {
				try {
					const raw = await Bun.file(filePath).text();
					const { frontmatter, body } = parseFrontmatter(raw);
					const rawDescription = frontmatter.description;
					let description = typeof rawDescription === "string" ? rawDescription : "";
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) {
								description += "...";
							}
						}
					}

					const source = "(legacy-resource-loader)";
					prompts.push({
						name: path.basename(filePath, path.extname(filePath)),
						description: description ? `${description} ${source}` : source,
						content: body,
						source,
					});
				} catch (err) {
					diagnostics.push({
						type: "warning",
						message: `Failed to load additional prompt template: ${errorMessage(err)}`,
						path: filePath,
					});
				}
			}
		}

		return { prompts, diagnostics };
	}

	get loaded(): boolean {
		return this.#loaded;
	}

	__getResolverState(): {
		cwd: string;
		agentDir: string;
		settingsPromise?: Promise<Settings>;
		eventBus: EventBus;
		extensionsResult: LoadExtensionsResult;
		skills: Skill[];
		prompts: PromptTemplate[];
		agentsFiles: AgentsFile[];
		systemPrompt: string | undefined;
		appendSystemPrompt: string[];
		extensionFactories: ExtensionFactory[];
	} {
		return {
			cwd: this.#state.cwd,
			agentDir: this.#state.agentDir,
			settingsPromise: this.#state.settingsPromise,
			eventBus: this.#state.eventBus,
			extensionsResult: this.#extensionsResult,
			skills: this.#skills,
			prompts: this.#prompts,
			agentsFiles: this.#agentsFiles,
			systemPrompt: this.#systemPrompt,
			appendSystemPrompt: this.#appendSystemPrompt,
			extensionFactories: this.#state.extensionFactories,
		};
	}
}

export type LegacyPiCreateAgentSessionOptions = CreateAgentSessionOptions & {
	resourceLoader?: ResourceLoader;
};

export async function createAgentSession(
	options: LegacyPiCreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const loader = options.resourceLoader;
	if (!loader) {
		return ompCreateAgentSession(options);
	}

	if (loader instanceof DefaultResourceLoader && !loader.loaded) {
		await loader.reload();
	}

	const state =
		loader instanceof DefaultResourceLoader
			? loader.__getResolverState()
			: {
					cwd: options.cwd ?? getProjectDir(),
					agentDir: options.agentDir ?? getAgentDir(),
					settingsPromise: undefined,
					eventBus: undefined,
					extensionsResult: loader.getExtensions(),
					skills: loader.getSkills().skills,
					prompts: loader.getPrompts().prompts,
					agentsFiles: loader.getAgentsFiles().agentsFiles,
					systemPrompt: loader.getSystemPrompt(),
					appendSystemPrompt: loader.getAppendSystemPrompt(),
					extensionFactories: [] as ExtensionFactory[],
				};

	const { resourceLoader: _, ...rest } = options;
	const forwarded: CreateAgentSessionOptions = {
		...rest,
		cwd: rest.cwd ?? state.cwd,
		agentDir: rest.agentDir ?? state.agentDir,
	};

	if (rest.eventBus === undefined && state.eventBus !== undefined) {
		forwarded.eventBus = state.eventBus;
	}
	if (rest.settings === undefined && rest.settingsManager === undefined && state.settingsPromise !== undefined) {
		forwarded.settingsManager = state.settingsPromise;
	}

	if (rest.preloadedExtensions === undefined && rest.preloadedExtensionPaths === undefined) {
		forwarded.preloadedExtensions = state.extensionsResult;
	}

	if (rest.skills === undefined) {
		forwarded.skills = state.skills;
	}
	if (rest.promptTemplates === undefined) {
		forwarded.promptTemplates = state.prompts;
	}
	if (rest.contextFiles === undefined) {
		forwarded.contextFiles = state.agentsFiles;
	}

	if (rest.systemPrompt === undefined && state.systemPrompt !== undefined) {
		forwarded.systemPrompt = state.systemPrompt;
	}
	if (rest.appendSystemPrompt === undefined && state.appendSystemPrompt.length > 0) {
		forwarded.appendSystemPrompt = state.appendSystemPrompt.join("\n\n");
	}

	return ompCreateAgentSession(forwarded);
}

export * from "../index";
export { formatBytes as formatSize } from "../tools/render-utils";
export { Type } from "./typebox";
