/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent, Model, TextContent, TSchema } from "@veyyon/ai";
import { factoryExportMissingMessage, moduleImportFailedMessage } from "@veyyon/kernel/loader/load-failure";
import { type ManifestHolder, manifestFromPackageJson } from "@veyyon/kernel/loader/manifest-key";
import * as TypeBox from "@veyyon/kernel/registry/typebox";
import { errorMessage, getAgentDir, hasFsCode, isEacces, isEnoent, logger, reportFault } from "@veyyon/utils";
import type { KeyId } from "@veyyon/utils/keys";
import { Type } from "arktype";
import * as zodModule from "zod/v4";
import {
	canonicalProjectRoot,
	describeProjectExecutable,
	describeRefusal,
	type ProjectExecutable,
	ProjectTrust,
} from "../../config/project-trust";
import { loadCapability } from "../../discovery";
import { type ExtensionModule, extensionModuleCapability } from "../../discovery/capability/extension-module";
import { type Hook, hookCapability } from "../../discovery/capability/hook";
import { discoverExtensionModulePaths, getExtensionNameFromPath } from "../../discovery/helpers";
import { type ExecOptions, execCommand, withSessionCpuExec } from "../../exec/exec";
import type { CustomMessagePayload } from "../../session/messages";
import { EventBus } from "../../utils/event-bus";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import { type CodingAgentApi, loadCodingAgentApi } from "../coding-agent-api";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";
import { resolvePath, withExitGuard } from "../utils";
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

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		// Read by the EXTENSION AUTHOR, not the operator: the only way to reach it
		// is to call an action method from the factory body. Say when the runtime
		// does exist, because "not initialized" reads like a veyyon fault.
		super(
			"The extension runtime does not exist yet, so this action method cannot be called from the factory body. " +
				"Fix: move the call into a handler registered with `api.on(...)`, which runs once the session is up.",
		);
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
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

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
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

/**
 * Create an Extension object with empty collections.
 */
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

/**
 * Create an Extension from an inline factory function.
 */
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

/**
 * How the trust gate is resolved for one load.
 *
 * `agentDir` names the profile whose decisions apply; omitted means the process-booted one,
 * resolved by the caller that has it. `trust` lets a caller pass a store it has already loaded
 * (the session loads one and hands the same instance to the MCP gate) so a startup path reads
 * the file once.
 *
 * `configuredPaths` are paths the OPERATOR named — `extensions:` in their config, a `--config`
 * overlay, an SDK argument — and they are exempt even when they live inside the project, because
 * that is where an extension is written while it is being developed. The exemption is sound
 * because there is no project-level `config.yml`: settings come from the profile and from home
 * (see `SOURCE_PATHS` in `discovery/helpers.ts`), so a repository cannot put a path in this list.
 * A caller that forgets to pass it gates MORE, never less, which is the direction a mistake has
 * to fail in.
 */
export interface ExtensionTrustOptions {
	agentDir?: string;
	trust?: ProjectTrust;
	configuredPaths?: readonly string[];
}

/**
 * Load extensions from paths.
 *
 * THE GATE LIVES HERE, not in the callers, because this is the only function in the product
 * that imports an extension module: `loadExtension` runs top-level code and then the factory,
 * and there are five call sites reaching it (the session, the shim, `veyyon models`, the SDK's
 * `discoverExtensions`, and subagents replaying a parent's path list). A gate in front of one
 * of them is a gate the other four walk around, and the dangerous default — "this caller
 * forgot" — has to be a refusal rather than an execution.
 *
 * A path OUTSIDE the project is the operator's own: their profile's extensions, an installed
 * plugin, a path they typed into `extensions:`. Those are unchanged. A path inside the project
 * is repository-controlled and needs a decision covering its exact bytes.
 */
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

/**
 * Build the per-path decision function, doing the store read and the root resolution once.
 *
 * Returns a function answering with a refusal sentence, or null when the path may load. When no
 * candidate path is inside the project the store is never opened at all, which is the common
 * case (a profile's own extensions) and keeps a cold startup free of an extra file read.
 */
async function openTrustGate(
	paths: string[],
	cwd: string,
	trustOptions?: ExtensionTrustOptions,
): Promise<(extPath: string) => Promise<string | null>> {
	const allow = async (): Promise<string | null> => null;
	if (paths.length === 0) return allow;

	const root = await canonicalProjectRoot(cwd);
	// A configured entry may name a FILE or a DIRECTORY, and discovery expands a directory into
	// the entry files inside it, so exact-path equality exempted the operator's `extensions: [./dev]`
	// and then gated every file that entry resolved to. Containment is the same claim the operator
	// made: they named that tree.
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

/**
 * Open the profile's store.
 *
 * A caller that names an agent dir gets that profile's decisions; a caller that does not gets
 * the process-booted profile, which is the only answer available to a free function and is
 * correct for every path that reaches here without a session.
 */
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

/**
 * Resolve extension entry points from a directory.
 */
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
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.veyyon`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * Subagents reuse the parent's collected paths via the SDK's
 * `preloadedExtensionPaths` option, then call {@link loadExtensions} themselves
 * so each session rebuilds Extension instances bound to its OWN
 * `ExtensionAPI` (cwd, eventBus, runtime). Forwarding the parent's
 * `LoadExtensionsResult` directly would reuse handlers/tools/commands that
 * closed over the parent's `cwd` and event bus.
 *
 * `agentDir` names WHICH profile supplies the user scope for both capabilities
 * loaded below. It defaults inside `loadCapability` (`options.agentDir ??
 * getAgentDir()`), so omitting it resolves the process-booted profile: pass it
 * whenever the caller has one, or a session rooted in another agent dir runs
 * the booted profile's hooks and extension modules.
 */
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

	// 1. Discover extension modules via capability API (native .veyyon/.pi only).
	// Scope the load to the native provider — the extension-module capability
	// also has claude/codex/gemini/opencode providers, and their items were
	// discarded here anyway (see #4198). The provider filter skips the walk
	// entirely instead of running four foreign directory scans and dropping
	// the results.
	const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
		...loadOptions,
		providers: ["native"],
	});
	for (const ext of discovered.items) {
		addPath(ext.path);
	}

	// 2. Discover JS/TS hook factories from hookCapability and bind them through
	// the extension runner, which owns the current runtime event bus. Hook
	// capability loading already applies hook-specific disabled ids; do not also
	// filter them through extension-module names.
	//
	// Every hook provider discovers ANY file under `hooks/{pre,post}/`, and the
	// claude and codex providers strip `.sh`/`.bash`/`.zsh`/`.fish` off the tool
	// name, so a shell hook is a shape they expect. But this is the only
	// production consumer of the capability and it can bind nothing but a JS/TS
	// module. A dropped hook is therefore named out loud: it was discovered, the
	// `/extensions` panel lists it as active, and running it is the one thing
	// that does not happen. Staying quiet here left the operator with a hook file
	// on disk, a row in the panel, and no execution and no explanation.
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

	// Both loads above answer with `items` AND `warnings`, and only `items` was
	// read. The warnings are not diagnostics about the scan; they are the user's
	// own `extensions:` entries failing: `Extension path not found: <path>` for a
	// mistyped path, `Invalid extension path in <settings>: <entry>` for a
	// non-string. Dropping them meant a typo in settings produced a session with
	// the extension absent and not one word about it anywhere.
	//
	// Through `reportFault` rather than a return value, because this is a free
	// function with no session handle — the case `utils/fault-sink.ts` exists
	// for. `createAgentSession` attaches a sink that lands these in the running
	// session's operator notices.
	for (const warning of [...discovered.warnings, ...hooks.warnings]) {
		reportFault({
			source: "extensions",
			// The warning itself is the user's own `extensions:` entry failing, so the
			// remedy is always the same edit: the settings list that named it.
			text:
				`${warning}. That extension is not loaded in this run. ` +
				"Fix: correct or drop that entry in the `extensions` setting, with " +
				"`veyyon config set extensions '[]'` to clear the list.",
			context: { warning },
		});
	}

	// 3. Discover extension entry points from installed plugins
	addPaths(await getAllPluginExtensionPaths(cwd));

	// 4. Explicitly configured paths
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

			// Same three discovery rules as the well-known agent directories, so
			// configured paths and discovered ones resolve a layout identically.
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

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
	return loadExtensions(paths, cwd, eventBus, undefined, { configuredPaths });
}
