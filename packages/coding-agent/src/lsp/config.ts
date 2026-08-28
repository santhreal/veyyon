import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$which,
	errorMessage,
	isMissingPath,
	isRecord,
	logger,
	parseJsonOrYamlByExtension,
	pathIsWithin,
	type WhichOptions,
} from "@veyyon/utils";
import { getConfigDirPaths } from "../config";
import { type ClaudePluginRoot, getPreloadedPluginRoots } from "../discovery/helpers";
import { BiomeClient } from "./clients/biome-client";
import { SwiftLintClient } from "./clients/swiftlint-client";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { ServerConfig } from "./types";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	idleTimeoutMs?: number;
	missingServers: MissingLspServer[];
}

export interface MissingLspServer {
	name: string;
	command: string;
	fileTypes: string[];
}

const PID_TOKEN = "$PID";

interface RawServerConfig extends Partial<ServerConfig> {
	extensionToLanguage?: unknown;
	initializationOptions?: unknown;
}

interface NormalizedConfig {
	servers: Record<string, RawServerConfig>;
	idleTimeoutMs?: number;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;

	const idleTimeoutMs = typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : undefined;
	const rawServers = value.servers;

	if (isRecord(rawServers)) {
		return { servers: rawServers as Record<string, RawServerConfig>, idleTimeoutMs };
	}

	const servers = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs")) as Record<
		string,
		RawServerConfig
	>;

	return { servers, idleTimeoutMs };
}

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : null;
}
function normalizeExtensionToFileTypes(value: unknown): string[] | null {
	if (!isRecord(value)) return null;
	const extensions = Object.keys(value).filter(extension => extension.length > 0);
	return extensions.length > 0 ? extensions : null;
}

function normalizeServerConfig(name: string, config: RawServerConfig): ServerConfig | null {
	const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
	const fileTypes =
		normalizeStringArray(config.fileTypes) ?? normalizeExtensionToFileTypes(config.extensionToLanguage);
	const rootMarkers = normalizeStringArray(config.rootMarkers) ?? (config.extensionToLanguage ? ["."] : null);

	if (!command || !fileTypes || !rootMarkers) {
		logger.warn("Ignoring invalid LSP server config (missing required fields).", { name });
		return null;
	}

	const args = Array.isArray(config.args)
		? config.args.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const initOptions = isRecord(config.initOptions)
		? config.initOptions
		: isRecord(config.initializationOptions)
			? config.initializationOptions
			: undefined;

	return {
		...config,
		command,
		args,
		fileTypes,
		rootMarkers,
		...(initOptions ? { initOptions } : {}),
	};
}

function readConfigFile(filePath: string): NormalizedConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if (!isMissingPath(error)) {
			logger.warn("LSP config file exists but could not be read; ignoring it.", {
				path: filePath,
				error: errorMessage(error),
			});
		}
		return null;
	}

	let parsed: unknown;
	try {
		parsed = parseJsonOrYamlByExtension(content, filePath);
	} catch (error) {
		logger.warn("LSP config file could not be parsed; ignoring it.", {
			path: filePath,
			error: errorMessage(error),
		});
		return null;
	}

	const normalized = normalizeConfig(parsed);
	if (!normalized) {
		logger.warn("LSP config file does not contain a server map; ignoring it.", { path: filePath });
	}
	return normalized;
}

function coerceServerConfigs(servers: Record<string, RawServerConfig>): Record<string, ServerConfig> {
	const result: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		const normalized = normalizeServerConfig(name, config);
		if (normalized) {
			result[name] = normalized;
		}
	}
	return result;
}

function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, RawServerConfig>,
): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [name, config] of Object.entries(overrides)) {
		if (merged[name]) {
			const candidate = { ...merged[name], ...config };
			const normalized = normalizeServerConfig(name, candidate);
			if (normalized) {
				merged[name] = normalized;
			} else {
				logger.warn("Ignoring invalid LSP overrides (keeping previous config).", { name });
			}
		} else {
			const normalized = normalizeServerConfig(name, config);
			if (normalized) {
				merged[name] = normalized;
			}
		}
	}
	return merged;
}

function applyRuntimeDefaults(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const updated: Record<string, ServerConfig> = { ...servers };

	if (updated.biome) {
		updated.biome = { ...updated.biome, createClient: BiomeClient.create };
	}

	if (updated.swiftlint) {
		updated.swiftlint = { ...updated.swiftlint, createClient: SwiftLintClient.create };
	}

	if (updated.omnisharp?.args) {
		const args = updated.omnisharp.args.map(arg => (arg === PID_TOKEN ? String(process.pid) : arg));
		updated.omnisharp = { ...updated.omnisharp, args };
	}

	return updated;
}

export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	for (const marker of markers) {
		if (marker.includes("*")) {
			if (entries === null) {
				try {
					entries = fs.readdirSync(cwd);
				} catch {
					entries = [];
					logger.warn("Failed to list directory for glob root marker.", { marker, cwd });
				}
			}
			const glob = new Bun.Glob(marker);
			for (const entry of entries) {
				if (glob.match(entry)) {
					return true;
				}
			}
			continue;
		}
		const filePath = path.join(cwd, marker);
		if (fs.existsSync(filePath)) {
			return true;
		}
	}
	return false;
}

export function hasRootMarkerAncestor(filePath: string, markers: string[]): boolean {
	if (markers.length === 0) return false;

	let dir = path.dirname(path.resolve(filePath));
	while (true) {
		if (hasRootMarkers(dir, markers)) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

const PYTHON_ROOT_MARKERS = [
	"pyproject.toml",
	"requirements.txt",
	"setup.py",
	"setup.cfg",
	"Pipfile",
	"pyrightconfig.json",
	"ruff.toml",
	".ruff.toml",
];

const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".venv/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".venv/Scripts" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: "venv/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: "venv/Scripts" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".env/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".env/Scripts" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	{ markers: ["go.mod", "go.sum", "go.work"], binDir: "bin" },
];

const WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

function resolveLocalCommand(basePath: string): string | null {
	if (fs.existsSync(basePath)) return basePath;
	if (process.platform !== "win32") return null;

	for (const extension of WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS) {
		const candidate = `${basePath}${extension}`;
		if (fs.existsSync(candidate)) return candidate;
	}

	return null;
}

function resolveCommandFromLocalRoot(command: string, cwd: string): string | null {
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (!hasRootMarkers(cwd, markers)) continue;
		const resolved = resolveLocalCommand(path.join(cwd, binDir, command));
		if (resolved) return resolved;
	}
	return null;
}

export interface ResolveCommandOptions extends Pick<WhichOptions, "cache" | "PATH"> {
	localRoots?: readonly string[];
}

export function resolveCommand(command: string, cwd: string, options?: ResolveCommandOptions): string | null {
	if (options?.localRoots) {
		for (const root of options.localRoots) {
			const resolved = resolveCommandFromLocalRoot(command, root);
			if (resolved) return resolved;
		}
	} else {
		const resolved = resolveCommandFromLocalRoot(command, cwd);
		if (resolved) return resolved;
	}

	if (!options) return $which(command);
	return $which(command, { cache: options.cache, PATH: options.PATH });
}

interface ConfigSource {
	read(): NormalizedConfig | null;
}

function fileConfigSource(filePath: string): ConfigSource {
	return {
		read: () => readConfigFile(filePath),
	};
}

function readMarketplaceLspConfig(root: ClaudePluginRoot): NormalizedConfig | null {
	const catalogPaths = [
		path.resolve(root.path, "..", "..", "marketplace.json"),
		path.resolve(root.path, "..", "..", ".claude-plugin", "marketplace.json"),
	];

	for (const catalogPath of catalogPaths) {
		let catalog: unknown;
		try {
			catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as unknown;
		} catch (error) {
			if (!isMissingPath(error)) {
				logger.warn("Plugin marketplace catalog could not be read; its LSP servers are being ignored.", {
					path: catalogPath,
					plugin: root.plugin,
					error: errorMessage(error),
				});
			}
			continue;
		}
		if (!isRecord(catalog) || !Array.isArray(catalog.plugins)) {
			logger.warn("Plugin marketplace catalog has no plugin list; its LSP servers are being ignored.", {
				path: catalogPath,
				plugin: root.plugin,
			});
			continue;
		}

		for (const plugin of catalog.plugins) {
			if (!isRecord(plugin) || plugin.name !== root.plugin) continue;

			const lspServers = plugin.lspServers;
			if (typeof lspServers === "string") {
				const configPath = path.resolve(root.path, lspServers);
				if (!pathIsWithin(root.path, configPath)) {
					logger.warn("Plugin LSP config path escapes the plugin directory; refusing to read it.", {
						plugin: root.plugin,
						declared: lspServers,
						resolved: configPath,
					});
					return null;
				}
				return readConfigFile(configPath);
			}
			if (isRecord(lspServers)) {
				return normalizeConfig({ servers: lspServers });
			}
			if (lspServers !== undefined) {
				logger.warn("Plugin declares lspServers as neither a config path nor a server map; ignoring it.", {
					plugin: root.plugin,
					type: typeof lspServers,
				});
			}
			return null;
		}
	}

	return null;
}

function marketplaceConfigSource(root: ClaudePluginRoot): ConfigSource {
	return {
		read: () => readMarketplaceLspConfig(root),
	};
}

function getConfigSources(cwd: string): ConfigSource[] {
	const filenames = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
	const sources: ConfigSource[] = [];

	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(cwd, filename)));
	}

	const projectDirs = getConfigDirPaths("", { user: false, project: true, cwd });
	for (const dir of projectDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename)));
		}
	}

	const userDirs = getConfigDirPaths("", { user: true, project: false });
	for (const dir of userDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename)));
		}
	}

	const pluginRoots = getPreloadedPluginRoots();
	for (const root of pluginRoots) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(root.path, filename)));
		}
		sources.push(marketplaceConfigSource(root));
	}

	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(os.homedir(), filename)));
	}

	return sources;
}

export function loadConfig(cwd: string): LspConfig {
	let mergedServers = coerceServerConfigs(DEFAULTS);

	const configSources = getConfigSources(cwd).reverse();
	let hasOverrides = false;

	let idleTimeoutMs: number | undefined;
	for (const source of configSources) {
		const parsed = source.read();
		if (!parsed) continue;
		const hasServerOverrides = Object.keys(parsed.servers).length > 0;
		if (hasServerOverrides) {
			hasOverrides = true;
			mergedServers = mergeServers(mergedServers, parsed.servers);
		}
		if (parsed.idleTimeoutMs !== undefined) {
			idleTimeoutMs = parsed.idleTimeoutMs;
		}
	}

	if (!hasOverrides) {
		const detected: Record<string, ServerConfig> = {};
		const missingServers: MissingLspServer[] = [];
		const defaultsWithRuntime = applyRuntimeDefaults(mergedServers);

		for (const [name, config] of Object.entries(defaultsWithRuntime)) {
			if (!hasRootMarkers(cwd, config.rootMarkers)) continue;

			const resolved = resolveCommand(config.command, cwd);
			if (!resolved) {
				missingServers.push({ name, command: config.command, fileTypes: config.fileTypes });
				continue;
			}

			detected[name] = { ...config, resolvedCommand: resolved };
		}

		return { servers: detected, idleTimeoutMs, missingServers };
	}

	const mergedWithRuntime = applyRuntimeDefaults(mergedServers);
	const available: Record<string, ServerConfig> = {};
	const missingServers: MissingLspServer[] = [];

	for (const [name, config] of Object.entries(mergedWithRuntime)) {
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (!resolved) {
			missingServers.push({ name, command: config.command, fileTypes: config.fileTypes });
			continue;
		}
		available[name] = { ...config, resolvedCommand: resolved };
	}

	return { servers: available, idleTimeoutMs, missingServers };
}

export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;
	const fileName = path.basename(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		const supportsFile = serverConfig.fileTypes.some(fileType => {
			const normalized = fileType.toLowerCase();
			const normalizedNoDot = normalized.startsWith(".") ? normalized.slice(1) : normalized;
			return (
				normalized === ext ||
				normalized === fileName ||
				normalizedNoDot === extNoDot ||
				normalizedNoDot === fileName
			);
		});

		if (supportsFile) {
			matches.push([name, serverConfig]);
		}
	}

	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}
