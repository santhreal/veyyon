/**
 * The extensions a session starts with, the custom TypeScript commands discovered beside them, the
 * prompt templates and file slash commands the session offers, and the report of skills that failed to
 * load.
 */

import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { errorMessage, logger, prefetch } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { type CustomCommandsLoadResult, loadCustomCommands } from "../extensibility/custom-commands";
import {
	type BuiltinExtensionFactory,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
} from "../extensibility/extensions";
import { loadBuiltinExtension } from "../extensibility/extensions/loader";
import type { SkillWarning } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { EventBus } from "../utils/event-bus";
import type { SessionCpuExecHooks } from "./cpu-limit";
import {
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	discoverSlashCommands,
	reportExtensionLoadFailures,
} from "./factory-extensions";
import type { CreateAgentSessionOptions } from "./factory-options";

/** What {@link loadStartupExtensions} and {@link loadStartupCustomCommands} read. */
export interface StartupExtensionsInput {
	options: Pick<
		CreateAgentSessionOptions,
		| "preloadedExtensions"
		| "preloadedExtensionPaths"
		| "preloadedNamedExtensionPaths"
		| "additionalExtensionPaths"
		| "disableExtensionDiscovery"
		| "extensions"
	>;
	cwd: string;
	agentDir: string;
	settings: Settings;
	eventBus: EventBus;
	cpuExec: SessionCpuExecHooks;
	operatorNotices: OperatorNotices;
}

/** The extensions a session loaded, and the paths a spawned agent reloads them from. */
export interface StartupExtensions {
	result: LoadExtensionsResult;
	/** Source paths a spawned agent reloads under its own `ExtensionAPI`; inline factories excluded. */
	paths: string[];
	/** Paths the operator named, which the trust check treats as the operator's own code. */
	namedPaths: string[];
}

/**
 * Load a session's extensions, then append the caller's inline `options.extensions` and the
 * product's `builtinFactories`, each bound to this session.
 *
 * Three sources, in order of preference. `preloadedExtensions` (the CLI) reuses instances the
 * caller loaded, shallow-cloning the list so the inline appends cannot mutate the caller's array;
 * the shared `runtime` carries flag values set before the session existed. `preloadedExtensionPaths`
 * (a spawned agent) skips the scan but loads each path again, so every extension binds to THIS
 * session's `ExtensionAPI`. Otherwise discovery runs in full. A caller that set
 * `disableExtensionDiscovery` and preloaded the result has already applied it.
 *
 * The trust check reads the session's profile, and a path the operator named is the operator's
 * own even inside the project. Load failures and withheld project extensions are reported on the
 * operator channel, including those of a preloaded result: this session is the one with a surface.
 *
 * Only an author's factory is handed `api.pi`, the package barrel. A session with no author
 * extensions binds the builtin factories without it and never loads the barrel.
 */
export async function loadStartupExtensions(
	input: StartupExtensionsInput,
	builtinFactories: readonly BuiltinExtensionFactory[],
): Promise<StartupExtensions> {
	const { options, cwd, eventBus, cpuExec } = input;
	const namedPaths = [
		...(options.additionalExtensionPaths ?? []),
		...(options.preloadedNamedExtensionPaths ?? []),
		...(input.settings.get("extensions") ?? []),
	];
	let result: LoadExtensionsResult;
	let paths: string[];
	if (options.preloadedExtensions) {
		result = { ...options.preloadedExtensions, extensions: options.preloadedExtensions.extensions.slice() };
		paths = result.extensions.map(ext => ext.resolvedPath).filter(p => !p.startsWith("<inline"));
	} else {
		paths =
			options.preloadedExtensionPaths ??
			(await logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(options, cwd, input.settings, input.agentDir),
			));
		result = await logger.time(
			"loadExtensions",
			loadExtensions,
			paths,
			cwd,
			eventBus,
			cpuExec.adoptPid,
			{ agentDir: input.agentDir, configuredPaths: namedPaths },
			cpuExec.gate,
		);
	}
	reportExtensionLoadFailures(result, input.operatorNotices);

	const authorFactories = options.extensions ?? [];
	for (const [index, factory] of authorFactories.entries()) {
		result.extensions.push(
			await loadExtensionFromFactory(
				factory,
				cwd,
				eventBus,
				result.runtime,
				`<inline-${index}>`,
				cpuExec.adoptPid,
				cpuExec.gate,
			),
		);
	}
	for (const [index, factory] of builtinFactories.entries()) {
		result.extensions.push(
			await loadBuiltinExtension(
				factory,
				cwd,
				eventBus,
				result.runtime,
				`<inline-${authorFactories.length + index}>`,
				cpuExec.adoptPid,
				cpuExec.gate,
			),
		);
	}
	return { result, paths, namedPaths };
}

/**
 * Register the providers `result`'s extensions queued, before model selection, so a model an
 * extension contributes resolves on resume and on fallback. The runtime provider catalogs then
 * load from the offline cache: a dynamic-only provider has no synchronous registration, so a cold
 * `--model` resume reads the same cache `veyyon models find` reads. Online discovery continues in
 * the background, and startup waits on no provider network fetch.
 */
export async function adoptStartupExtensionProviders(
	modelRegistry: ModelRegistry,
	result: LoadExtensionsResult,
): Promise<void> {
	modelRegistry.adoptExtensionProviders(
		result.extensions.map(extension => extension.path),
		result.runtime.pendingProviderRegistrations,
	);
	await modelRegistry.refreshRuntimeProviders("offline");
	void modelRegistry.refreshRuntimeProviders().catch(error => {
		logger.warn("runtime provider discovery failed", { error: errorMessage(error) });
	});
}

/**
 * The custom TypeScript slash commands of the session's project and profile, none when extension
 * discovery is off. Each command that fails to load is reported on the operator channel.
 */
export async function loadStartupCustomCommands(
	input: Pick<StartupExtensionsInput, "options" | "cwd" | "agentDir" | "cpuExec" | "operatorNotices">,
): Promise<CustomCommandsLoadResult> {
	if (input.options.disableExtensionDiscovery) return { commands: [], errors: [] };
	const result = await logger.time("discoverCustomCommands", loadCustomCommands, {
		cwd: input.cwd,
		agentDir: input.agentDir,
		adoptSpawnedPid: input.cpuExec.adoptPid,
		gateSpawn: input.cpuExec.gate,
	});
	for (const { path, error } of result.errors) {
		logger.error("Failed to load custom command", { path, error });
		input.operatorNotices.error("commands", `${path}: ${error}`);
	}
	return result;
}

/** Report each skill that failed to load on the operator channel. */
export function reportSkillWarnings(operatorNotices: OperatorNotices, warnings: readonly SkillWarning[]): void {
	for (const warning of warnings) {
		operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
	}
}

/** The prompt templates and file slash commands a session offers, each discovery started and prefetched. */
export interface CommandInputDiscovery {
	readonly promptTemplates: Promise<PromptTemplate[]>;
	readonly slashCommands: Promise<FileSlashCommand[]>;
}

/**
 * Start discovering the prompt templates and slash commands of `cwd`. An input the caller supplied is
 * used as given: `undefined` means discover it, and `[]` means resolved to nothing on purpose.
 */
export function discoverCommandInputs(
	cwd: string,
	agentDir: string,
	supplied: Pick<CreateAgentSessionOptions, "promptTemplates" | "slashCommands">,
): CommandInputDiscovery {
	return {
		promptTemplates: prefetch(
			supplied.promptTemplates !== undefined
				? Promise.resolve(supplied.promptTemplates)
				: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir),
		),
		slashCommands: prefetch(
			supplied.slashCommands !== undefined
				? Promise.resolve(supplied.slashCommands)
				: logger.time("discoverSlashCommands", discoverSlashCommands, cwd, agentDir),
		),
	};
}
