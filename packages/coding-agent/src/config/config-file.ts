import * as fs from "node:fs";
import * as path from "node:path";
import { isArkErrors } from "@veyyon/ai/utils/schema";
import {
	atomicWriteFileSync,
	getAgentDir,
	isEnoent,
	logger,
	pathStateSync,
	reportFault,
	truncate,
} from "@veyyon/utils";
import type { Type } from "arktype";
import { JSONC, YAML } from "bun";

interface ConfigSchemaError {
	instancePath: string;
	message: string | undefined;
}

const migratedPaths = new Set<string>();

function migrationKey(jsonPath: string, ymlPath: string): string {
	return `${jsonPath}\u0000${ymlPath}`;
}

function migrateJsonToYml(jsonPath: string, ymlPath: string) {
	const key = migrationKey(jsonPath, ymlPath);
	if (migratedPaths.has(key)) return;
	try {
		if (fs.existsSync(ymlPath)) {
			migratedPaths.add(key);
			return;
		}
		if (!fs.existsSync(jsonPath)) {
			migratedPaths.add(key);
			return;
		}

		const content = fs.readFileSync(jsonPath, "utf-8");
		const parsed = JSONC.parse(content);
		if (!parsed) {
			logger.warn("migrateJsonToYml: invalid json structure", { path: jsonPath });
			migratedPaths.add(key);
			return;
		}
		atomicWriteFileSync(ymlPath, YAML.stringify(parsed, null, 2));
		migratedPaths.add(key);
	} catch (error) {
		logger.warn("migrateJsonToYml: migration failed", { error: String(error) });
	}
}

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: Type;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

const MAX_CONFIG_ISSUE_LENGTH = 200;
const MAX_CONFIG_ISSUES = 20;
const MAX_CONFIG_ERROR_LENGTH = 4500;

export class ConfigError extends Error {
	readonly #message: string;
	constructor(
		public readonly id: string,
		public readonly schemaErrors: ConfigSchemaError[] | null | undefined,
		public readonly other?: { err: unknown; stage: string },
		public readonly configPath?: string,
	) {
		let messages: string[] | undefined;
		let cause: Error | undefined;
		let klass: string;
		let elided = 0;

		if (schemaErrors) {
			klass = "Schema";
			elided = Math.max(0, schemaErrors.length - MAX_CONFIG_ISSUES);
			messages = schemaErrors
				.slice(0, MAX_CONFIG_ISSUES)
				.map(e => truncate(`${e.instancePath || "root"}: ${e.message}`, MAX_CONFIG_ISSUE_LENGTH));
		} else if (other) {
			klass = other.stage;
			if (other.err instanceof Error) {
				messages = [truncate(other.err.message, MAX_CONFIG_ISSUE_LENGTH)];
				cause = other.err;
			} else {
				messages = [truncate(String(other.err), MAX_CONFIG_ISSUE_LENGTH)];
			}
		} else {
			klass = "Unknown";
		}
		if (elided > 0) messages?.push(`… ${elided} more of ${schemaErrors?.length} problem(s) not shown`);

		const where = configPath ? ` (${configPath})` : "";
		const title = `Failed to load config file ${id}${where}, ${klass} error:`;
		let message: string;
		switch (messages?.length ?? 0) {
			case 0:
				message = title.slice(0, -1);
				break;
			case 1:
				message = `${title} ${messages![0]}`;
				break;
			default:
				message = `${title}\n${messages!.map(m => `  - ${m}`).join("\n")}`;
		}
		if (configPath) message = `${message}\nFix: edit ${configPath}, or delete it to fall back to the defaults.`;
		message = truncate(message, MAX_CONFIG_ERROR_LENGTH);

		super(message, { cause });
		this.name = "LoadError";
		this.#message = message;
	}

	get message(): string {
		return this.#message;
	}

	toString(): string {
		return this.message;
	}
}

export type LoadStatus = "ok" | "error" | "not-found";

export type LoadResult<T> =
	| { value?: null; error: ConfigError; status: "error" }
	| { value: T; error?: undefined; status: "ok" }
	| { value?: null; error?: unknown; status: "not-found" };

export interface DeferredSchema {
	readonly deferredSchema: true;
	readonly build: () => Type;
}

export function deferSchema(build: () => Type): DeferredSchema {
	return { deferredSchema: true, build };
}

function isDeferredSchema(schema: Type | DeferredSchema): schema is DeferredSchema {
	return typeof schema === "object" && schema !== null && "deferredSchema" in schema;
}

export class ConfigFile<T> implements IConfigFile<T> {
	readonly #basePath: string;
	readonly #yamlFallbackPath: string | null;
	readonly #jsonMigrationPath: string | null;
	readonly #schemaSource: Type | DeferredSchema;
	#resolvedSchema?: Type;
	#cache?: LoadResult<T>;
	#auxValidate?: (value: T) => void;
	#reportedUnreadable = false;

	constructor(
		readonly id: string,
		schema: Type | DeferredSchema,
		configPath: string = path.join(getAgentDir(), `${id}.yml`),
	) {
		this.#schemaSource = schema;
		this.#basePath = configPath;
		if (configPath.endsWith(".yml")) {
			this.#yamlFallbackPath = `${configPath.slice(0, -4)}.yaml`;
			this.#jsonMigrationPath = `${configPath.slice(0, -4)}.json`;
		} else if (configPath.endsWith(".yaml")) {
			this.#yamlFallbackPath = null;
			this.#jsonMigrationPath = `${configPath.slice(0, -5)}.json`;
		} else if (configPath.endsWith(".json") || configPath.endsWith(".jsonc")) {
			this.#yamlFallbackPath = null;
			this.#jsonMigrationPath = null;
		} else {
			this.#yamlFallbackPath = null;
			throw new Error(`Invalid config file path: ${configPath}`);
		}
	}

	#ensureMigrated(): void {
		if (!this.#jsonMigrationPath) return;
		const baseState = pathStateSync(this.#basePath);
		if (baseState === "unreadable") return;
		if (this.#yamlFallbackPath && baseState === "absent" && fs.existsSync(this.#yamlFallbackPath)) {
			return;
		}
		migrateJsonToYml(this.#jsonMigrationPath, this.#basePath);
	}

	get schema(): Type {
		this.#resolvedSchema ??= isDeferredSchema(this.#schemaSource) ? this.#schemaSource.build() : this.#schemaSource;
		return this.#resolvedSchema;
	}

	relocate(configPath?: string): ConfigFile<T> {
		if (!configPath || configPath === this.#basePath) return this;
		const result = new ConfigFile<T>(this.id, this.#schemaSource, configPath);
		result.#auxValidate = this.#auxValidate;
		result.#ensureMigrated();
		return result;
	}

	#resolveReadPath(): string {
		const baseState = pathStateSync(this.#basePath);
		if (baseState === "present") {
			this.#reportedUnreadable = false;
			return this.#basePath;
		}
		if (baseState === "unreadable") {
			if (!this.#reportedUnreadable) {
				this.#reportedUnreadable = true;
				reportFault({
					source: "config",
					text: `${this.#basePath} exists but could not be read, so this config is not being loaded and no fallback is being used in its place. Check its permissions and whether its filesystem is mounted.`,
					context: { path: this.#basePath, config: this.id },
				});
			}
			return this.#basePath;
		}
		if (this.#yamlFallbackPath && pathStateSync(this.#yamlFallbackPath) === "present") {
			return this.#yamlFallbackPath;
		}
		return this.#basePath;
	}

	getMtimeMs(): number | null {
		try {
			return fs.statSync(this.#resolveReadPath()).mtimeMs;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async getMtimeMsAsync(): Promise<number | null> {
		const file = Bun.file(this.path());
		if (!(await file.exists())) return null;
		const lm = file.lastModified;
		return typeof lm === "number" && Number.isFinite(lm) ? lm : null;
	}

	withValidation(name: string, validate: (value: T) => void): this {
		const prev = this.#auxValidate;
		this.#auxValidate = (value: T) => {
			prev?.(value);
			try {
				validate(value);
			} catch (error) {
				throw new ConfigError(this.id, undefined, { err: error, stage: `Validate(${name})` }, this.path());
			}
		};
		return this;
	}

	createDefault(): T {
		const parsed = this.schema({});
		if (!(parsed instanceof Error)) return parsed as T;
		const fallback = this.schema(undefined);
		if (!(fallback instanceof Error)) return fallback as T;
		throw new ConfigError(
			this.id,
			undefined,
			{ err: new Error("Schema produced no default value"), stage: "createDefault" },
			this.path(),
		);
	}

	#storeCache(result: LoadResult<T>): LoadResult<T> {
		this.#cache = result;
		return result;
	}

	#parseContent(content: string): LoadResult<T> {
		try {
			let parsed: unknown;
			const readPath = this.#resolveReadPath();
			if (readPath.endsWith(".json") || readPath.endsWith(".jsonc")) {
				parsed = JSONC.parse(content);
			} else if (readPath.endsWith(".yml") || readPath.endsWith(".yaml")) {
				parsed = YAML.parse(content);
			} else {
				throw new Error(`Invalid config file path: ${readPath}`);
			}

			const checked = this.schema(parsed);
			if (isArkErrors(checked)) {
				const schemaErrors: ConfigSchemaError[] = checked.map(error => ({
					instancePath: error.path.length === 0 ? "root" : error.path.join("."),
					message: error.problem,
				}));
				const error = new ConfigError(this.id, schemaErrors, undefined, this.#resolveReadPath());
				logger.warn("Failed to parse config file", { path: this.path(), error });
				return this.#storeCache({ error, status: "error" });
			}
			const value = checked as T;
			try {
				this.#auxValidate?.(value);
			} catch (error) {
				const wrapped =
					error instanceof ConfigError
						? error
						: new ConfigError(this.id, undefined, { err: error, stage: "AuxValidate" }, this.#resolveReadPath());
				return this.#storeCache({ error: wrapped, status: "error" });
			}
			return this.#storeCache({ value, status: "ok" });
		} catch (error) {
			logger.warn("Failed to parse config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Unexpected" }, this.#resolveReadPath()),
				status: "error",
			});
		}
	}

	tryLoad(): LoadResult<T> {
		if (this.#cache) return this.#cache;
		this.#ensureMigrated();

		let content: string;
		try {
			content = fs.readFileSync(this.#resolveReadPath(), "utf-8").trim();
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to read config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Read" }, this.#resolveReadPath()),
				status: "error",
			});
		}
		return this.#parseContent(content);
	}

	async tryLoadAsync(): Promise<LoadResult<T>> {
		if (this.#cache) return this.#cache;
		this.#ensureMigrated();

		let content: string;
		try {
			content = (await Bun.file(this.#resolveReadPath()).text()).trim();
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to read config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Read" }, this.#resolveReadPath()),
				status: "error",
			});
		}
		return this.#parseContent(content);
	}

	load(): T | null {
		return this.tryLoad().value ?? null;
	}

	async loadAsync(): Promise<T | null> {
		return (await this.tryLoadAsync()).value ?? null;
	}

	loadOrDefault(): T {
		return this.tryLoad().value ?? this.createDefault();
	}

	async loadOrDefaultAsync(): Promise<T> {
		return (await this.tryLoadAsync()).value ?? this.createDefault();
	}

	path(): string {
		return this.#resolveReadPath();
	}

	invalidate() {
		this.#cache = undefined;
	}
}
