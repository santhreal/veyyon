import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent, Model, TextContent, TSchema } from "@veyyon/ai";
import type { KeyId } from "@veyyon/tui";
import { errorMessage, getAgentDir, hasFsCode, isEacces, isEnoent, logger, reportFault } from "@veyyon/utils";
import { Type } from "arktype";
import * as zodModule from "zod/v4";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { loadCapability } from "../../discovery";
import { discoverExtensionModulePaths, getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand, withSessionCpuExec } from "../../exec/exec";
import {
	canonicalProjectRoot,
	describeProjectExecutable,
	describeRefusal,
	type ProjectExecutable,
	ProjectTrust,
} from "../../security/project-trust";
import type { CustomMessagePayload } from "../../session/messages";
import { EventBus } from "../../utils/event-bus";
import { type CodingAgentApi, loadCodingAgentApi } from "../coding-agent-api";
import { factoryExportMissingMessage, moduleImportFailedMessage } from "../load-failure";
import { type ManifestHolder, manifestFromPackageJson } from "../manifest-key";
import { loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";
import * as TypeBox from "../typebox";

import { resolvePath, withExitGuard } from "../utils";
import type { HandlerFn, LoadedExtensionModule } from "./loader-helpers";

import { getExtensionFactory } from "./loader-helpers";
import type {
	AssistantThinkingRenderer,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	LoadedExtension,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types";

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super(
			"The extension runtime does not exist yet, so this action method cannot be called from the factory body. " +
				"Fix: move the call into a handler registered with `api.on(...)`, which runs once the session is up.",
		);
	}
}

export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = Type;
	readonly zod = zodModule;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];

	constructor(
		public readonly pi: CodingAgentApi,
		private readonly extension: LoadedExtension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
		private readonly adoptSpawnedPid?: (pid: number) => void,
		private readonly gateSpawn?: (what: string) => Promise<void>,
	) {}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		this.extension.tools.set(tool.name, {
			definition: tool,
			extensionPath: this.extension.path,
		});
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(
			command,
			args,
			options?.cwd ?? this.cwd,
			withSessionCpuExec(options, this.adoptSpawnedPid, this.gateSpawn, "an extension command"),
		);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): string[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.runtime.pendingProviderRegistrations.push({ name, config, sourceId: this.extension.path });
	}
}

function createExtension(extensionPath: string, resolvedPath: string): LoadedExtension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<{ extension: LoadedExtension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await withExitGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				extension: null,
				error: factoryExportMissingMessage("extension"),
			};
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = new ConcreteExtensionAPI(
			await loadCodingAgentApi(),
			extension,
			runtime,
			cwd,
			eventBus,
			adoptSpawnedPid,
			gateSpawn,
		);
		await withExitGuard(async () => {
			await factory(api);
		});

		return { extension, error: null };
	} catch (err) {
		return { extension: null, error: moduleImportFailedMessage("extension", errorMessage(err)) };
	}
}

export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadedExtension> {
	const extension = createExtension(name, name);
	const api = new ConcreteExtensionAPI(
		await loadCodingAgentApi(),
		extension,
		runtime,
		cwd,
		eventBus,
		adoptSpawnedPid,
		gateSpawn,
	);
	await factory(api);
	return extension;
}

export interface ExtensionTrustOptions {
	agentDir?: string;
	trust?: ProjectTrust;
	configuredPaths?: readonly string[];
}

export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	adoptSpawnedPid?: (pid: number) => void,
	trustOptions?: ExtensionTrustOptions,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadExtensionsResult> {
	const extensions: LoadedExtension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const withheld: Array<{ path: string; reason: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();
	const gate = await openTrustGate(paths, cwd, trustOptions);

	for (const extPath of paths) {
		const refusal = await gate(extPath);
		if (refusal) {
			withheld.push({ path: extPath, reason: refusal });
			continue;
		}

		const { extension, error } = await loadExtension(
			extPath,
			cwd,
			resolvedEventBus,
			runtime,
			adoptSpawnedPid,
			gateSpawn,
		);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		withheld,
		runtime,
	};
}

async function openTrustGate(
	paths: string[],
	cwd: string,
	trustOptions?: ExtensionTrustOptions,
): Promise<(extPath: string) => Promise<string | null>> {
	const allow = async (): Promise<string | null> => null;
	if (paths.length === 0) return allow;

	const root = await canonicalProjectRoot(cwd);
	const exempt = (trustOptions?.configuredPaths ?? []).map(configured => resolvePath(configured, cwd));
	const isExempt = (resolved: string): boolean =>
		exempt.some(entry => {
			if (entry === resolved) return true;
			const relative = path.relative(entry, resolved);
			return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
		});
	const candidates = new Map<string, ProjectExecutable>();
	for (const extPath of paths) {
		const resolved = resolvePath(extPath, cwd);
		if (isExempt(resolved)) continue;
		const executable = await describeProjectExecutable(resolved, root);
		if (executable) candidates.set(extPath, executable);
	}
	if (candidates.size === 0) return allow;

	const trust = trustOptions?.trust ?? (await loadTrustStore(trustOptions?.agentDir));
	return async extPath => {
		const executable = candidates.get(extPath);
		if (!executable) return null;
		const verdict = trust.evaluate(root, executable);
		if (verdict === "trusted") return null;
		return describeRefusal("extensions", executable.relativePath, verdict);
	};
}

async function loadTrustStore(agentDir?: string): Promise<ProjectTrust> {
	return await ProjectTrust.load(agentDir ?? getAgentDir());
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as ManifestHolder<ExtensionManifest>;
		const manifest = manifestFromPackageJson(pkg);
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn(
			`The extension manifest ${packageJsonPath} could not be read, so this directory's declared entry points ` +
				`are not loaded and only its index.ts/index.js is tried: ${errorMessage(error)}. ` +
				"Fix: check the file's permissions and that it is valid JSON.",
			{ path: packageJsonPath, error: errorMessage(error) },
		);
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
		} else {
			throw err;
		}
	}

	return null;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	agentDir?: string,
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds
		? { cwd, agentDir, disabledExtensions: disabledExtensionIds }
		: { cwd, agentDir };

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
		...loadOptions,
		providers: ["native"],
	});
	for (const ext of discovered.items) {
		addPath(ext.path);
	}

	const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
	for (const hook of hooks.items) {
		if (isExtensionFile(path.basename(hook.path))) {
			addPath(hook.path);
			continue;
		}
		reportFault({
			source: "extensions",
			text: `Hook ${hook.path} is not a JS/TS module, so it is not loaded in this run. Hooks run as extension modules: rename it to .ts or .js and export a factory.`,
			context: { hookPath: hook.path, hookType: hook.type, tool: hook.tool },
		});
	}

	for (const warning of [...discovered.warnings, ...hooks.warnings]) {
		reportFault({
			source: "extensions",
			text:
				`${warning}. That extension is not loaded in this run. ` +
				"Fix: correct or drop that entry in the `extensions` setting, with " +
				"`veyyon config set extensions '[]'` to clear the list.",
			context: { warning },
		});
	}

	addPaths(await getAllPluginExtensionPaths(cwd));

	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionModulePaths(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	return allPaths;
}

export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
	return loadExtensions(paths, cwd, eventBus, undefined, { configuredPaths });
}
