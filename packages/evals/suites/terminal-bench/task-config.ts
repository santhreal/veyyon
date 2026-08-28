import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@veyyon/utils";
import { parse, stringify } from "smol-toml";

export type TaskOS = "linux" | "windows";
export type NetworkMode = "public" | "no-network" | "allowlist";
export type VerifierEnvironmentMode = "separate" | "shared";
export type MultiStepRewardStrategy = "mean" | "final";
export type MCPTransport = "stdio" | "sse" | "streamable-http";

export interface TaskAuthor {
	readonly name: string;
	readonly email?: string | null;
}

export interface TaskPackageInfo {
	readonly name: string;
	readonly version?: string | null;
	readonly description: string;
	readonly authors?: readonly TaskAuthor[];
	readonly keywords?: readonly string[];
}

export interface TaskMetadata {
	readonly author_name?: string | readonly string[] | null;
	readonly author_email?: string | readonly string[] | null;
	readonly author_organization?: string | readonly string[] | null;
	readonly category?: string | null;
	readonly subcategory?: string | null;
	readonly tags?: readonly string[];
	readonly expert_time_estimate_hours?: number | null;
	readonly [key: string]: unknown;
}

export interface TaskHealthcheckConfig {
	readonly command: string;
	readonly interval_sec?: number;
	readonly timeout_sec?: number;
	readonly start_period_sec?: number;
	readonly retries?: number;
}

export interface TaskTpuSpec {
	readonly type: string;
	readonly topology: string;
}

export interface TaskMCPServerConfig {
	readonly name: string;
	readonly transport?: MCPTransport;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface TaskArtifactConfig {
	readonly source: string;
	readonly destination?: string | null;
	readonly exclude?: readonly string[];
	readonly service?: string | null;
}

export interface TaskEnvironmentConfig {
	readonly build_timeout_sec: number;
	readonly docker_image?: string | null;
	readonly os: TaskOS;
	readonly cpus?: number | null;
	readonly memory_mb?: number | null;
	readonly storage_mb?: number | null;
	readonly gpus?: number | null;
	readonly gpu_types?: readonly string[] | null;
	readonly tpu?: TaskTpuSpec | null;
	readonly network_mode: NetworkMode;
	readonly allowed_hosts?: readonly string[] | null;
	readonly workdir?: string | null;
	readonly env?: Readonly<Record<string, string>>;
	readonly skills_dir?: string | null;
	readonly healthcheck?: TaskHealthcheckConfig | null;
	readonly mcp_servers?: readonly TaskMCPServerConfig[];
}

export interface TaskVerifierCollectConfig {
	readonly service: string;
	readonly command: string;
	readonly destination?: string | null;
}

export interface TaskVerifierConfig {
	readonly timeout_sec: number;
	readonly environment_mode?: VerifierEnvironmentMode | null;
	readonly user?: string | number | null;
	readonly env?: Readonly<Record<string, string>>;
	readonly network_mode?: NetworkMode | null;
	readonly allowed_hosts?: readonly string[] | null;
	readonly collect?: readonly TaskVerifierCollectConfig[];
	readonly environment?: TaskEnvironmentConfig | null;
}

export interface TaskAgentConfig {
	readonly timeout_sec?: number | null;
	readonly user?: string | number | null;
	readonly network_mode?: NetworkMode | null;
	readonly allowed_hosts?: readonly string[] | null;
}

export interface TaskSolutionConfig {
	readonly env?: Readonly<Record<string, string>>;
}

export interface TaskStepConfig {
	readonly name: string;
	readonly instruction?: string | null;
	readonly timeout_sec?: number | null;
	readonly verifier: TaskVerifierConfig;
	readonly artifacts?: readonly (string | TaskArtifactConfig)[];
}

export interface TaskConfig {
	readonly schema_version: string;
	readonly task?: TaskPackageInfo | null;
	readonly metadata: TaskMetadata;
	readonly verifier: TaskVerifierConfig;
	readonly agent: TaskAgentConfig;
	readonly environment: TaskEnvironmentConfig;
	readonly solution: TaskSolutionConfig;
	readonly artifacts: readonly (string | TaskArtifactConfig)[];
	readonly source?: string | null;
	readonly multi_step_reward_strategy?: MultiStepRewardStrategy | null;
	readonly steps?: readonly TaskStepConfig[] | null;
}

/**
 * Parses size strings like "2048M", "4G", "1024K" to integer megabytes.
 */
function parseSizeToMb(sizeStr: string): number {
	const trimmed = sizeStr.trim().toUpperCase();
	if (trimmed.endsWith("G")) {
		return Math.trunc(Number.parseFloat(trimmed.slice(0, -1)) * 1024);
	}
	if (trimmed.endsWith("M")) {
		return Math.trunc(Number.parseFloat(trimmed.slice(0, -1)));
	}
	if (trimmed.endsWith("K")) {
		return Math.trunc(Number.parseFloat(trimmed.slice(0, -1)) / 1024);
	}
	throw new Error(`Invalid size format "${sizeStr}". Expected format like '4G', '2048M', or '1024K'.`);
}

function parseStringRecord(raw: unknown, context: string): Readonly<Record<string, string>> {
	if (!isRecord(raw)) {
		return Object.freeze({});
	}
	const rec: Record<string, string> = {};
	for (const [key, val] of Object.entries(raw)) {
		if (typeof val !== "string") {
			throw new Error(`Invalid ${context} entry for "${key}": expected string, got ${typeof val}`);
		}
		rec[key] = val;
	}
	return Object.freeze(rec);
}

function parseNetworkMode(raw: unknown, context: string): NetworkMode {
	if (raw === "public" || raw === "no-network" || raw === "allowlist") {
		return raw;
	}
	throw new Error(
		`Invalid network_mode "${String(raw)}" in ${context}. Expected "public", "no-network", or "allowlist".`,
	);
}

function parseArtifactEntry(raw: unknown): string | TaskArtifactConfig {
	if (typeof raw === "string") {
		if (raw.split("/").includes("..")) {
			throw new Error(`Artifact source must not contain '..' components, got: "${raw}"`);
		}
		return raw;
	}
	if (isRecord(raw)) {
		const obj = raw;
		if (typeof obj.source !== "string" || obj.source.trim() === "") {
			throw new Error(`Artifact config missing required string "source", got: ${JSON.stringify(raw)}`);
		}
		if (obj.source.split("/").includes("..")) {
			throw new Error(`Artifact source must not contain '..' components, got: "${obj.source}"`);
		}
		return Object.freeze({
			source: obj.source,
			destination: typeof obj.destination === "string" ? obj.destination : null,
			exclude: Array.isArray(obj.exclude) ? Object.freeze(obj.exclude.map(String)) : undefined,
			service: typeof obj.service === "string" ? obj.service : null,
		});
	}
	throw new Error(`Invalid artifact entry: expected string or table, got ${typeof raw}`);
}

function parseEnvironmentConfig(raw: unknown, context: string): TaskEnvironmentConfig {
	const obj: Record<string, unknown> = isRecord(raw) ? raw : {};

	let networkMode: NetworkMode = "public";
	if (obj.network_mode !== undefined) {
		networkMode = parseNetworkMode(obj.network_mode, `${context}.network_mode`);
	} else if (obj.allow_internet !== undefined) {
		networkMode = obj.allow_internet ? "public" : "no-network";
	}

	let memoryMb: number | null = null;
	if (typeof obj.memory_mb === "number") {
		memoryMb = obj.memory_mb;
	} else if (typeof obj.memory === "string") {
		memoryMb = parseSizeToMb(obj.memory);
	} else if (typeof obj.memory === "number") {
		memoryMb = obj.memory;
	}

	let storageMb: number | null = null;
	if (typeof obj.storage_mb === "number") {
		storageMb = obj.storage_mb;
	} else if (typeof obj.storage === "string") {
		storageMb = parseSizeToMb(obj.storage);
	} else if (typeof obj.storage === "number") {
		storageMb = obj.storage;
	}

	let os: TaskOS = "linux";
	if (typeof obj.os === "string") {
		const lowerOs = obj.os.toLowerCase();
		if (lowerOs === "linux" || lowerOs === "windows") {
			os = lowerOs;
		} else {
			throw new Error(`Invalid OS "${obj.os}" in ${context}. Expected "linux" or "windows".`);
		}
	}

	let buildTimeoutSec = 600.0;
	if (typeof obj.build_timeout_sec === "number") {
		buildTimeoutSec = obj.build_timeout_sec;
	}

	let tpu: TaskTpuSpec | null = null;
	if (isRecord(obj.tpu)) {
		const tpuObj = obj.tpu;
		if (typeof tpuObj.type === "string" && typeof tpuObj.topology === "string") {
			tpu = Object.freeze({ type: tpuObj.type, topology: tpuObj.topology });
		}
	}

	let healthcheck: TaskHealthcheckConfig | null = null;
	if (isRecord(obj.healthcheck)) {
		const hc = obj.healthcheck;
		if (typeof hc.command === "string") {
			healthcheck = Object.freeze({
				command: hc.command,
				interval_sec: typeof hc.interval_sec === "number" ? hc.interval_sec : undefined,
				timeout_sec: typeof hc.timeout_sec === "number" ? hc.timeout_sec : undefined,
				start_period_sec: typeof hc.start_period_sec === "number" ? hc.start_period_sec : undefined,
				retries: typeof hc.retries === "number" ? hc.retries : undefined,
			});
		}
	}

	let mcpServers: TaskMCPServerConfig[] | undefined;
	if (Array.isArray(obj.mcp_servers)) {
		mcpServers = obj.mcp_servers.map(s => {
			const sObj: Record<string, unknown> = isRecord(s) ? s : {};
			return Object.freeze({
				name: String(sObj.name ?? ""),
				transport: sObj.transport as MCPTransport | undefined,
				command: typeof sObj.command === "string" ? sObj.command : undefined,
				args: Array.isArray(sObj.args) ? Object.freeze(sObj.args.map(String)) : undefined,
				url: typeof sObj.url === "string" ? sObj.url : undefined,
				env: parseStringRecord(sObj.env, `${context}.mcp_servers.env`),
			});
		});
	}

	return Object.freeze({
		build_timeout_sec: buildTimeoutSec,
		docker_image: typeof obj.docker_image === "string" ? obj.docker_image : null,
		os,
		cpus: typeof obj.cpus === "number" ? obj.cpus : null,
		memory_mb: memoryMb,
		storage_mb: storageMb,
		gpus: typeof obj.gpus === "number" ? obj.gpus : null,
		gpu_types: Array.isArray(obj.gpu_types) ? Object.freeze(obj.gpu_types.map(String)) : null,
		tpu,
		network_mode: networkMode,
		allowed_hosts: Array.isArray(obj.allowed_hosts) ? Object.freeze(obj.allowed_hosts.map(String)) : null,
		workdir: typeof obj.workdir === "string" ? obj.workdir : null,
		env: parseStringRecord(obj.env, `${context}.env`),
		skills_dir: typeof obj.skills_dir === "string" ? obj.skills_dir : null,
		healthcheck,
		mcp_servers: mcpServers ? Object.freeze(mcpServers) : undefined,
	});
}

function parseVerifierConfig(raw: unknown): TaskVerifierConfig {
	const obj: Record<string, unknown> = isRecord(raw) ? raw : {};

	let envMode: VerifierEnvironmentMode | null = null;
	if (obj.environment_mode === "separate" || obj.environment_mode === "shared") {
		envMode = obj.environment_mode;
	} else if (obj.environment_mode !== undefined && obj.environment_mode !== null) {
		throw new Error(
			`Invalid verifier environment_mode "${String(obj.environment_mode)}". Expected "separate" or "shared".`,
		);
	}

	let verifierEnv: TaskEnvironmentConfig | null = null;
	if (isRecord(obj.environment)) {
		verifierEnv = parseEnvironmentConfig(obj.environment, "verifier.environment");
	}

	let collectList: TaskVerifierCollectConfig[] | undefined;
	if (Array.isArray(obj.collect)) {
		collectList = obj.collect.map(c => {
			const cObj: Record<string, unknown> = isRecord(c) ? c : {};
			return Object.freeze({
				service: String(cObj.service ?? ""),
				command: String(cObj.command ?? ""),
				destination: typeof cObj.destination === "string" ? cObj.destination : null,
			});
		});
	}

	return Object.freeze({
		timeout_sec: typeof obj.timeout_sec === "number" ? obj.timeout_sec : 600.0,
		environment_mode: envMode,
		user: typeof obj.user === "string" || typeof obj.user === "number" ? obj.user : null,
		env: parseStringRecord(obj.env, "verifier.env"),
		network_mode: obj.network_mode ? parseNetworkMode(obj.network_mode, "verifier.network_mode") : null,
		allowed_hosts: Array.isArray(obj.allowed_hosts) ? Object.freeze(obj.allowed_hosts.map(String)) : null,
		collect: collectList ? Object.freeze(collectList) : undefined,
		environment: verifierEnv,
	});
}

function parseAgentConfig(raw: unknown): TaskAgentConfig {
	const obj: Record<string, unknown> = isRecord(raw) ? raw : {};
	return Object.freeze({
		timeout_sec: typeof obj.timeout_sec === "number" ? obj.timeout_sec : null,
		user: typeof obj.user === "string" || typeof obj.user === "number" ? obj.user : null,
		network_mode: obj.network_mode ? parseNetworkMode(obj.network_mode, "agent.network_mode") : null,
		allowed_hosts: Array.isArray(obj.allowed_hosts) ? Object.freeze(obj.allowed_hosts.map(String)) : null,
	});
}

function parsePackageInfo(raw: unknown): TaskPackageInfo | null {
	if (!isRecord(raw)) {
		return null;
	}
	const obj = raw;
	if (typeof obj.name !== "string" || obj.name.trim() === "") {
		throw new Error(`[task] section missing required "name" property.`);
	}

	let authorsList: TaskAuthor[] | undefined;
	if (Array.isArray(obj.authors)) {
		authorsList = obj.authors.map(a => {
			const aObj: Record<string, unknown> = isRecord(a) ? a : {};
			return Object.freeze({
				name: String(aObj.name ?? ""),
				email: typeof aObj.email === "string" ? aObj.email : null,
			});
		});
	}

	return Object.freeze({
		name: obj.name,
		version: typeof obj.version === "string" ? obj.version : null,
		description: typeof obj.description === "string" ? obj.description : "",
		authors: authorsList ? Object.freeze(authorsList) : undefined,
		keywords: Array.isArray(obj.keywords) ? Object.freeze(obj.keywords.map(String)) : undefined,
	});
}

function parseMetadata(raw: unknown): TaskMetadata {
	if (!isRecord(raw)) {
		return Object.freeze({});
	}
	const obj = raw;
	const result: Record<string, unknown> = { ...obj };

	if (Array.isArray(result.tags)) {
		result.tags = Object.freeze(result.tags.map(String));
	}
	if (Array.isArray(result.author_name)) {
		result.author_name = Object.freeze(result.author_name.map(String));
	}
	if (Array.isArray(result.author_email)) {
		result.author_email = Object.freeze(result.author_email.map(String));
	}
	if (Array.isArray(result.author_organization)) {
		result.author_organization = Object.freeze(result.author_organization.map(String));
	}

	return Object.freeze(result);
}

/**
 * Parses raw TOML text into a validated TaskConfig descriptor.
 * Fails closed on invalid TOML or schema violations.
 */
export function parseTaskConfig(rawToml: string): TaskConfig {
	let raw: unknown;
	try {
		raw = parse(rawToml);
	} catch (error) {
		throw new Error(`Failed to parse task.toml: ${String(error)}`, { cause: error });
	}

	if (!isRecord(raw)) {
		throw new Error("Invalid task.toml structure: expected top-level table.");
	}

	const doc = raw;

	// Schema version handling (with legacy "version" alias)
	let schemaVersion = "1.4";
	if (typeof doc.schema_version === "string") {
		schemaVersion = doc.schema_version;
	} else if (typeof doc.version === "string") {
		schemaVersion = doc.version;
	}

	// Artifacts
	const artifacts: (string | TaskArtifactConfig)[] = [];
	if (Array.isArray(doc.artifacts)) {
		for (const item of doc.artifacts) {
			artifacts.push(parseArtifactEntry(item));
		}
	}

	// Multi-step reward strategy
	let rewardStrategy: MultiStepRewardStrategy | null = null;
	if (doc.multi_step_reward_strategy === "mean" || doc.multi_step_reward_strategy === "final") {
		rewardStrategy = doc.multi_step_reward_strategy;
	} else if (doc.multi_step_reward_strategy !== undefined && doc.multi_step_reward_strategy !== null) {
		throw new Error(
			`Invalid multi_step_reward_strategy "${String(doc.multi_step_reward_strategy)}". Expected "mean" or "final".`,
		);
	}

	return Object.freeze({
		schema_version: schemaVersion,
		task: parsePackageInfo(doc.task),
		metadata: parseMetadata(doc.metadata),
		verifier: parseVerifierConfig(doc.verifier),
		agent: parseAgentConfig(doc.agent),
		environment: parseEnvironmentConfig(doc.environment, "environment"),
		solution: Object.freeze({
			env: parseStringRecord((doc.solution as Record<string, unknown> | undefined)?.env, "solution.env"),
		}),
		artifacts: Object.freeze(artifacts),
		source: typeof doc.source === "string" ? doc.source : null,
		multi_step_reward_strategy: rewardStrategy,
		steps: null,
	});
}

/**
 * Loads and parses a task.toml from a file path or task directory.
 */
export async function loadTaskConfig(taskDirOrTomlPath: string): Promise<TaskConfig> {
	let targetPath = taskDirOrTomlPath;
	try {
		const s = await stat(taskDirOrTomlPath);
		if (s.isDirectory()) {
			targetPath = join(taskDirOrTomlPath, "task.toml");
		}
	} catch (error) {
		throw new Error(`Failed to locate task.toml at "${taskDirOrTomlPath}": ${String(error)}`, {
			cause: error,
		});
	}

	let content: string;
	try {
		content = await readFile(targetPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read task.toml at "${targetPath}": ${String(error)}`, {
			cause: error,
		});
	}

	return parseTaskConfig(content);
}

/**
 * Serializes a TaskConfig back to TOML.
 */
export function serializeTaskConfig(config: TaskConfig): string {
	const tomlObj: Record<string, unknown> = {
		schema_version: config.schema_version,
	};

	if (config.artifacts.length > 0) {
		tomlObj.artifacts = config.artifacts.map(a => {
			if (typeof a === "string") return a;
			const res: Record<string, unknown> = { source: a.source };
			if (a.destination) res.destination = a.destination;
			if (a.exclude && a.exclude.length > 0) res.exclude = a.exclude;
			if (a.service) res.service = a.service;
			return res;
		});
	}

	if (config.task) {
		const tObj: Record<string, unknown> = {
			name: config.task.name,
			description: config.task.description,
		};
		if (config.task.version) tObj.version = config.task.version;
		if (config.task.authors && config.task.authors.length > 0) {
			tObj.authors = config.task.authors.map(a => ({
				name: a.name,
				...(a.email ? { email: a.email } : {}),
			}));
		}
		if (config.task.keywords && config.task.keywords.length > 0) {
			tObj.keywords = config.task.keywords;
		}
		tomlObj.task = tObj;
	}

	if (Object.keys(config.metadata).length > 0) {
		tomlObj.metadata = { ...config.metadata };
	}

	const vObj: Record<string, unknown> = {
		timeout_sec: config.verifier.timeout_sec,
	};
	if (config.verifier.environment_mode) {
		vObj.environment_mode = config.verifier.environment_mode;
	}
	if (config.verifier.user !== null && config.verifier.user !== undefined) {
		vObj.user = config.verifier.user;
	}
	if (config.verifier.network_mode) {
		vObj.network_mode = config.verifier.network_mode;
	}
	if (config.verifier.allowed_hosts && config.verifier.allowed_hosts.length > 0) {
		vObj.allowed_hosts = config.verifier.allowed_hosts;
	}
	if (config.verifier.env && Object.keys(config.verifier.env).length > 0) {
		vObj.env = { ...config.verifier.env };
	}
	if (config.verifier.environment) {
		const env = config.verifier.environment;
		const vEnvObj: Record<string, unknown> = {
			build_timeout_sec: env.build_timeout_sec,
			os: env.os,
			network_mode: env.network_mode,
		};
		if (env.cpus !== null && env.cpus !== undefined) vEnvObj.cpus = env.cpus;
		if (env.memory_mb !== null && env.memory_mb !== undefined) vEnvObj.memory_mb = env.memory_mb;
		if (env.storage_mb !== null && env.storage_mb !== undefined) vEnvObj.storage_mb = env.storage_mb;
		if (env.gpus !== null && env.gpus !== undefined) vEnvObj.gpus = env.gpus;
		if (env.gpu_types && env.gpu_types.length > 0) vEnvObj.gpu_types = env.gpu_types;
		vObj.environment = vEnvObj;
	}
	tomlObj.verifier = vObj;

	const aObj: Record<string, unknown> = {};
	if (config.agent.timeout_sec !== null && config.agent.timeout_sec !== undefined) {
		aObj.timeout_sec = config.agent.timeout_sec;
	}
	if (config.agent.user !== null && config.agent.user !== undefined) {
		aObj.user = config.agent.user;
	}
	if (config.agent.network_mode) {
		aObj.network_mode = config.agent.network_mode;
	}
	if (config.agent.allowed_hosts && config.agent.allowed_hosts.length > 0) {
		aObj.allowed_hosts = config.agent.allowed_hosts;
	}
	tomlObj.agent = aObj;

	const eObj: Record<string, unknown> = {
		build_timeout_sec: config.environment.build_timeout_sec,
		os: config.environment.os,
		network_mode: config.environment.network_mode,
	};
	if (config.environment.docker_image) eObj.docker_image = config.environment.docker_image;
	if (config.environment.cpus !== null && config.environment.cpus !== undefined) eObj.cpus = config.environment.cpus;
	if (config.environment.memory_mb !== null && config.environment.memory_mb !== undefined)
		eObj.memory_mb = config.environment.memory_mb;
	if (config.environment.storage_mb !== null && config.environment.storage_mb !== undefined)
		eObj.storage_mb = config.environment.storage_mb;
	if (config.environment.gpus !== null && config.environment.gpus !== undefined) eObj.gpus = config.environment.gpus;
	if (config.environment.gpu_types && config.environment.gpu_types.length > 0)
		eObj.gpu_types = config.environment.gpu_types;
	if (config.environment.workdir) eObj.workdir = config.environment.workdir;
	if (config.environment.allowed_hosts && config.environment.allowed_hosts.length > 0)
		eObj.allowed_hosts = config.environment.allowed_hosts;
	if (config.environment.env && Object.keys(config.environment.env).length > 0)
		eObj.env = { ...config.environment.env };
	if (config.environment.healthcheck) eObj.healthcheck = { ...config.environment.healthcheck };
	if (config.environment.mcp_servers && config.environment.mcp_servers.length > 0) {
		eObj.mcp_servers = config.environment.mcp_servers.map(s => ({ ...s }));
	}
	tomlObj.environment = eObj;

	if (config.solution.env && Object.keys(config.solution.env).length > 0) {
		tomlObj.solution = { env: { ...config.solution.env } };
	}

	if (config.source) tomlObj.source = config.source;
	if (config.multi_step_reward_strategy) tomlObj.multi_step_reward_strategy = config.multi_step_reward_strategy;

	return stringify(tomlObj);
}
