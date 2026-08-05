import * as fs from "node:fs";
import * as path from "node:path";
import {
	atomicWriteFileSync,
	getAgentDir,
	isEnoent,
	logger,
	pathStateSync,
	reportFault,
	truncate,
} from "@veyyon/utils";
import { ArkErrors, type Type } from "arktype";
import { JSONC, YAML } from "bun";

/** Minimal subset of the AJV ConfigSchemaError shape this module actually relies on. */
interface ConfigSchemaError {
	instancePath: string;
	message: string | undefined;
}

/**
 * Module-private cache of JSON → YAML migrations this process already ran.
 * Prevents `ConfigFile.relocate()` / repeated `tryLoad()` calls from re-running
 * the migration over and over on the boot path.
 */
const migratedPaths = new Set<string>();

function migrationKey(jsonPath: string, ymlPath: string): string {
	return `${jsonPath}\u0000${ymlPath}`;
}

/**
 * Synchronous JSON → YAML migration kept for callers that still want the
 * eager path (settings init, tests that observe migration completion).
 * Idempotent — re-running is a no-op.
 */
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
		// Atomic write (temp + fsync + rename) so an interrupted migration never
		// leaves a partial .yml. A torn file would keep existing, short-circuit
		// this migration on every later run (the `existsSync(ymlPath)` guard
		// above), and fail to parse in #parseContent — a config the operator can
		// never load without manually deleting the corrupt file.
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

/**
 * Bound on ONE issue line. ArkType writes the REJECTED VALUE into its problem
 * text (`transport: must be "pi-native" (was "zzz…")`), so a single oversized
 * value in the file sets the length of the message about it: a 50,000-character
 * value measured a 50,100-character error.
 */
const MAX_CONFIG_ISSUE_LENGTH = 200;
/**
 * Issue lines listed before the rest becomes a count. Bounding each line does
 * not bound the list: 400 short bad providers measured 25,538 characters across
 * 401 lines, every line under the per-issue cap. Twenty is enough to see the
 * shape of what is wrong with the file; the count says how much more there is.
 */
const MAX_CONFIG_ISSUES = 20;
/**
 * Hard ceiling on the whole message. The two caps above are expected to keep it
 * far under this; it exists because per-part caps do not compose into a
 * whole-message bound on their own, and this message is printed line by line by
 * `veyyon models` and pushed into the startup notification list.
 */
const MAX_CONFIG_ERROR_LENGTH = 4500;

export class ConfigError extends Error {
	readonly #message: string;
	/**
	 * @param configPath The file that failed, so the message can name it. The old
	 *   message named only the config ID (`models`), and an ID is not a location:
	 *   the same ID resolves to a different file per profile, and the loader falls
	 *   back across `.yml`, `.yaml` and `.json`, so "Failed to load config file
	 *   models" left the reader guessing which of three names under which of
	 *   several roots to open. The loader logged the path to the file log on the
	 *   line below the throw and never gave it to the operator.
	 */
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
		// The remedy is the file, because that is the only thing the reader can act
		// on: a schema problem names the key inside it, and a parse problem names
		// no key at all. Without this the message stated a fault and no next step.
		if (configPath) message = `${message}\nFix: edit ${configPath}, or delete it to fall back to the defaults.`;
		// Last, so it holds whatever the parts above produced. Per-part caps do not
		// compose into a whole-message bound, and this string reaches a transcript.
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

/**
 * A schema supplied as a builder instead of a constructed Type, so ConfigFile
 * defers ArkType construction until the config is actually validated (missing
 * files never pay it). Use {@link deferSchema} — a plain thunk is ambiguous
 * because ArkType Types are themselves callable.
 */
export interface DeferredSchema {
	readonly deferredSchema: true;
	readonly build: () => Type;
}

/** Mark a schema builder for lazy construction on first validation. */
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
	/**
	 * Whether the unreadable-base fault has been reported for this instance.
	 *
	 * `#resolveReadPath` runs on every `tryLoad` and every `getMtimeMs`, and `getMtimeMs` is what a
	 * config watcher polls, so reporting per call would put the same line in the log on a timer. The
	 * operator channel collapses identical notices by text, but the file log does not. One report per
	 * instance per state change is the honest amount: the fault is a property of the file, not of the
	 * poll.
	 */
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
			// JSON configs are still supported without migration.
			this.#jsonMigrationPath = null;
		} else {
			this.#yamlFallbackPath = null;
			throw new Error(`Invalid config file path: ${configPath}`);
		}
	}

	/**
	 * Run the JSON → YAML migration synchronously, if applicable. Idempotent.
	 * Sync callers (tests, settings init) hit this implicitly via {@link tryLoad}.
	 */
	#ensureMigrated(): void {
		if (!this.#jsonMigrationPath) return;
		const baseState = pathStateSync(this.#basePath);
		// An unreadable base is a base that IS there, so a migration must not run against it. The probe
		// was `!fs.existsSync(this.#basePath)`, which reads unreadable as absent, so the one state where
		// writing is unsafe was the state that let the write through.
		if (baseState === "unreadable") return;
		if (this.#yamlFallbackPath && baseState === "absent" && fs.existsSync(this.#yamlFallbackPath)) {
			return;
		}
		migrateJsonToYml(this.#jsonMigrationPath, this.#basePath);
	}

	/** The validation schema, constructing a deferred one on first access. */
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

	/**
	 * Which file to read: the base path, or the YAML fallback when the base is genuinely not there.
	 *
	 * FALLING BACK IS ONLY CORRECT FOR AN ABSENT BASE, and `fs.existsSync` cannot express that: it
	 * answers `false` for a path that exists and cannot be reached exactly as it does for one that is not
	 * there. The three-state probe separates them, and an unreadable base RESOLVES TO ITSELF so the read
	 * that follows fails on the file the operator meant rather than succeeding against another one.
	 *
	 * HOW NARROW THE WRONG-FILE CASE ACTUALLY IS, because the first version of this comment claimed more
	 * than the code could do and the tests said so. `<name>.yml` and `<name>.yaml` are derived from one
	 * `configPath`, so they always share a directory: an unsearchable directory takes both down and the
	 * fallback is unreachable anyway, and a `chmod 000` FILE still stats fine through its parent, which
	 * is why {@link pathStateSync} calls it `present`. The resolution that genuinely changes is a
	 * SYMLINKED base pointing somewhere unreachable, where the fallback beside the link is readable and
	 * used to win silently.
	 *
	 * THE REPORT IS THE PART THAT MATTERS IN EVERY CASE. An unreachable base already produced a
	 * `ConfigError`, but nothing put it in front of an operator: `logger.warn` is file-only, and
	 * `getMtimeMs` turns the same failure into a throw a watcher swallows. The fault channel is the one
	 * surface that reaches a person, and "your config exists and could not be read" is the sentence that
	 * stops them hunting for a syntax error in a file that was never opened.
	 */
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
			if (checked instanceof ArkErrors) {
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
