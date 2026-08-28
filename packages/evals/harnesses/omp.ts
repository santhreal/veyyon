import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, errorMessage, logger } from "@veyyon/utils";
import type { ContainerProgramContext, ProgramFile, StagedProgram }  from "../engine/container-program"
import { CONTAINER_PROGRAM_VERSION, containerProgramPath, programDirFor, stageHarnessProgram }  from "../engine/container-program"
import type { SystemJobConfigContext, SystemPreflightContext, SystemPreflightResult, SystemStageContext }  from "../engine/contracts"
import { containerLocalEndpointEnv, isLocalInferenceModel, localEndpointAllowedDomains, localEndpointRefusal } from "../engine/local-inference-endpoint";
import { parseModelId } from "../engine/trial-model";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../engine/contracts";
import { veyBinaryPath } from "../engine/package-paths";
import { decideAuthSeed, probeCredentialStore } from "../engine/auth-seed";
import { AUTH_DB_SOURCES, requireStagedAuthCanServeToken } from "../engine/auth-preflight";

/** Where the staged omp files land inside a task container. */
const CONTAINER_DIR = "/opt/omp-assets";

/**
 * Where omp writes its session transcripts inside the container. The assets directory is
 * root-owned, so the agent user cannot create a directory in it; the container's own `/tmp`
 * is writable and is discarded with the container.
 */
const SESSION_DIR = "/tmp/omp-sessions";

/**
 * Candidate omp auth DB paths on the host, in priority order. omp is the upstream
 * veyyon forks from, so its own store at `~/.omp/agent/agent.db` is checked first,
 * then the veyyon shared-auth stores that hold the same credential shape.
 */
const OMP_AUTH_DB_SOURCES = [
	path.join(os.homedir(), ".omp", "agent", "agent.db"),
	...AUTH_DB_SOURCES,
];

/**
 * Resolve a host auth DB that can serve the run, or null when none exists.
 * Reads the same decision the veyyon harness makes, against omp's candidate list.
 */
function resolveOmpAuthDb(): string | null {
	const mtimeOf = (p: string): number | undefined =>
		fs.existsSync(p) ? fs.statSync(p).mtimeMs : undefined;
	const decision = decideAuthSeed(OMP_AUTH_DB_SOURCES, OMP_AUTH_DB_SOURCES[0], mtimeOf, probeCredentialStore);
	if (decision.kind === "missing") return null;
	return decision.source;
}


/** Provider keys the container may reach. */
const ALLOWED_DOMAINS: readonly string[] = [
	".googleapis.com",
	".google.com",
	".anthropic.com",
	".openai.com",
	".openrouter.ai",
	".opencode.ai",
	".models.dev",
];

/** The environment variable a provider's key is read from, derived from the model selector. */
function authEnvVarFor(model: string): string {
	const slashIndex = model.indexOf("/");
	const provider = slashIndex > 0 ? model.slice(0, slashIndex) : model;
	return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** The omp binary the run measures: an explicit flag, else the one on PATH. */
function resolveOmpBinary(options: Readonly<Record<string, unknown>>): string | null {
	const flag = options["omp-binary"];
	if (typeof flag === "string") return path.resolve(flag);
	return $which("omp");
}

/** The provider key: an explicit flag, else the provider's variable, else the opencode one. */
function resolveApiKey(options: Readonly<Record<string, unknown>>, authEnvVar: string): string | null {
	const flag = options["omp-api-key"];
	if (typeof flag === "string") return flag;
	return process.env[authEnvVar] ?? process.env.OPENCODE_API_KEY ?? null;
}

/**
 * Parse `vey models refresh <provider> --json` output and build a models.yml
 * that defines the model statically. The omp binary reads models.yml from
 * ~/.omp/agent/models.yml at startup, adding the model to its static catalog
 * before model resolution runs. This bypasses the background-discovery race
 * that loses dynamically-discovered models when --model is explicit, and
 * provides metadata (contextWindow, maxTokens, reasoning) that omp's own
 * `models refresh` lacks because it has no models.dev overlay.
 */
function buildModelsYml(refreshJson: string, modelSelector: string, apiKey: string, gatewayUrl: string | null = null): string | null {
	const slashIndex = modelSelector.indexOf("/");
	if (slashIndex < 1) return null;
	const provider = modelSelector.slice(0, slashIndex);
	const modelId = modelSelector.slice(slashIndex + 1);

	const providerBaseUrls: Record<string, string> = {
		"opencode-go": "https://opencode.ai/zen/v1",
		opencode: "https://opencode.ai/zen/v1",
	};
	const providerApis: Record<string, string> = {
		"opencode-go": "openai-compatible",
		opencode: "openai-compatible",
	};

	let entries: Array<{ id?: string; name?: string; reasoning?: boolean; input?: number; output?: number; contextWindow?: number; maxTokens?: number }> = [];
	const trimmed = refreshJson.trim();
	if (trimmed.startsWith("{")) {
		// `vey models refresh --json` outputs a single JSON object: {"models":[...]}
		const parsed = JSON.parse(trimmed) as { models?: Array<{ id?: string; name?: string; reasoning?: boolean; input?: number; output?: number; contextWindow?: number; maxTokens?: number }> };
		entries = parsed.models ?? [];
	} else {
		// NDJSON: one JSON object per line
		for (const line of refreshJson.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try { entries.push(JSON.parse(t)); } catch { /* skip */ }
		}
	}
	for (const entry of entries) {
		if (entry.id !== modelId && entry.name !== modelId) continue;
		const contextWindow = entry.contextWindow ?? entry.input ?? 131_072;
		const maxTokens = entry.maxTokens ?? entry.output ?? 8192;
		const reasoning = entry.reasoning ?? false;
		const baseUrl = providerBaseUrls[provider] ?? (gatewayUrl ? `${gatewayUrl.replace(/\/+$/, "")}/v1` : "https://opencode.ai/zen/v1");
		const api = providerApis[provider] ?? (gatewayUrl ? "openai-responses" : "openai-compatible");

		return [
			"providers:",
			`  ${provider}:`,
			`    baseUrl: ${JSON.stringify(baseUrl)}`,
		`    apiKey: ${JSON.stringify(apiKey || (gatewayUrl ? "no-auth" : apiKey))}`,
			`    api: ${JSON.stringify(api)}`,
			"    models:",
			`      - id: ${JSON.stringify(modelId)}`,
			`        name: ${JSON.stringify(entry.name ?? modelId)}`,
			`        reasoning: ${reasoning}`,
			`        contextWindow: ${contextWindow}`,
			`        maxTokens: ${maxTokens}`,
			"        cost:",
			"          input: 0.0",
			"          output: 0.0",
			"          cacheRead: 0.0",
			"          cacheWrite: 0.0",
			"",
		].join("\n");
	}
	return null;
}

/**
 * Ask the vey binary for the provider's catalog and turn it into a models.yml.
 *
 * Best effort: a run whose host has no vey binary, or whose refresh fails, stages no
 * models.yml and omp resolves the model through its own discovery. The program marks the
 * file optional for that reason.
 *
 * A locally served model stages none either. Its catalog is what the endpoint reports at
 * startup, including the context window the model was loaded with, and every vendor base
 * URL this builder knows is wrong for it.
 */
function ompModelsYml(
	model: string,
	apiKey: string,
	options: Readonly<Record<string, unknown>>,
	gatewayUrl: string | null,
): string | null {
	if (isLocalInferenceModel(model)) return null;
	const flag = options.binary ?? options["vey-binary"];
	const candidate = typeof flag === "string" ? path.resolve(flag) : veyBinaryPath();
	const veyBinary = fs.existsSync(candidate) ? candidate : null;
	if (!veyBinary) return null;
	const provider = parseModelId(model).provider;
	// `vey models refresh` reads OAuth credentials from the host auth DB, so it works
	// without an API key env var. The env var is set only when a key was resolved.
	const refreshEnv = apiKey
		? { ...process.env, [authEnvVarFor(model)]: apiKey }
		: process.env;
	try {
		const refreshOutput = execFileSync(veyBinary, ["models", "refresh", provider, "--json"], {
			encoding: "utf8",
			timeout: 30_000,
			env: refreshEnv,
		});
		return buildModelsYml(refreshOutput, model, apiKey, gatewayUrl);
	} catch (err) {
		logger.warn(`warning: failed to build models.yml for omp via 'vey models refresh': ${errorMessage(err)}`);
		return null;
	}
}

export class OmpAdapter implements HarnessAdapter {
	readonly id = "omp";
	readonly displayName = "Oh My Pi (omp)";
	readonly description = "Oh My Pi (omp) CLI agent headlessly executing containerized benchmark tasks.";
	readonly flags: readonly string[] = ["omp-binary", "omp-api-key"];
	readonly defaultModel = "opencode-go/deepseek-v4-flash";

	readonly capabilities: HarnessCapabilities = {
		replay: false,
		compaction: false,
		armAttachments: false,
		promptOverrides: false,
	};

	readonly backends = {
		pier: {
			agentImportPath: "omp_agent:OmpAgent",
			containerAssetsDir: CONTAINER_DIR,
		},
		harbor: {
			agentName: "omp",
			agentImportPath: "program_agent:ProgramAgent",
			containerAssetsDir: CONTAINER_DIR,
			requiresDocker: true,
			authGateway: true,
		},
	} as const;

	/**
	 * The one declaration of an omp trial: the compiled binary, the auth credential, the
	 * optional static catalog, the headless invocation and where its transcripts land.
	 *
	 * Pier and Harbor both stage this and both hand it to the same executor, so an asset this
	 * names is an asset the container agent reads. Auth is either an API key in `omp.env`
	 * (never on the command line) or an OAuth credential store staged as `auth-agent.db`,
	 * copied to ~/.omp/agent/agent.db by the setup step.
	 */
	containerProgram(context: ContainerProgramContext): StagedProgram {
		const options = context.options;
		const model = context.model || this.defaultModel;
		const authEnvVar = authEnvVarFor(model);
		const apiKey = resolveApiKey(options, authEnvVar) ?? "";
		const binary = resolveOmpBinary(options);
	const gatewayUrl = typeof options.gatewayUrl === "string" ? options.gatewayUrl : null;
	const gatewayToken = typeof options.gatewayToken === "string" ? options.gatewayToken : null;
	// When routing through the gateway, the gateway token is the apiKey omp
	// sends as the bearer. Without it, omp sends "no-auth" and gets 401.
	const effectiveApiKey = gatewayUrl ? (gatewayToken || apiKey || "no-auth") : apiKey;
	const modelsYml = ompModelsYml(model, effectiveApiKey, options, gatewayUrl);
		const localEndpoint = containerLocalEndpointEnv(model);
		const authDb = resolveOmpAuthDb();

	const files: ProgramFile[] = [];
	if (binary) files.push({ file: "omp", source: { copy: binary }, mode: 0o755 });
	// omp is a Bun script (#!/usr/bin/env bun). Task containers may pin an older
	// Bun than omp was built for, so stage the host's bun binary and invoke omp
	// through it instead of relying on the container's shebang resolution.
	const hostBun = $which("bun");
	if (hostBun && fs.existsSync(hostBun)) {
		files.push({ file: "bun", source: { copy: hostBun }, mode: 0o755 });
	}
	// When an API key is resolved, it travels in omp.env. When auth is OAuth from
	// the auth DB, the env lines are empty — omp reads the token from ~/.omp/agent.
	const envLines = [`${authEnvVar}=${apiKey}`, `OPENCODE_API_KEY=${apiKey}`];
	for (const [key, value] of Object.entries(localEndpoint ?? {})) envLines.push(`${key}=${value}`);
	files.push({
		file: "omp.env",
		source: { text: `${envLines.join("\n")}\n` },
		mode: 0o600,
	});
	if (modelsYml) files.push({ file: "models.yml", source: { text: modelsYml } });
	if (authDb) files.push({ file: "auth-agent.db", source: { copy: authDb }, mode: 0o600 });

		return {
			program: {
				version: CONTAINER_PROGRAM_VERSION,
				harness: this.id,
				containerDir: CONTAINER_DIR,
				assets: [
					{ file: "omp", dest: `${CONTAINER_DIR}/omp`, mode: "0755" },
					{ file: "bun", dest: `${CONTAINER_DIR}/bun`, mode: "0755", optional: true },
					{ file: "omp.env", dest: `${CONTAINER_DIR}/omp.env`, mode: "0600" },
					{ file: "models.yml", dest: `${CONTAINER_DIR}/models.yml`, optional: true },
					{ file: "auth-agent.db", dest: `${CONTAINER_DIR}/auth-agent.db`, mode: "0600", optional: true },
				],
				binaryAsset: "omp",
				setup: [
					`mkdir -p ${SESSION_DIR} ~/.omp/agent`,
					`if [ -f ${CONTAINER_DIR}/models.yml ]; then cp ${CONTAINER_DIR}/models.yml ~/.omp/agent/models.yml; fi`,
					`if [ -f ${CONTAINER_DIR}/auth-agent.db ]; then cp ${CONTAINER_DIR}/auth-agent.db ~/.omp/agent/agent.db; fi`,
				],
				// --mode json streams NDJSON events (thinking deltas, tool calls, text) to
				// stdout instead of buffering the result until exit, so a long trial is
				// observable in the log while it runs.
			command: `${CONTAINER_DIR}/bun {{assets}}/omp --model {{model}} --auto-approve --print --mode json --session-dir ${SESSION_DIR} {{instruction}}`,
				envFile: `${CONTAINER_DIR}/omp.env`,
				logPath: "/logs/agent/omp.txt",
				sessions: { sources: [SESSION_DIR], pattern: "*.jsonl" },
				allowedDomains: localEndpoint ? localEndpointAllowedDomains(model) : ALLOWED_DOMAINS,
				usage: "omp",
			},
			files,
		};
	}

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const ompBinary = resolveOmpBinary(options);

		if (!ompBinary || !fs.existsSync(ompBinary)) {
			missing.push("omp binary on PATH or --omp-binary (install omp or pass --omp-binary <path>)");
		} else if (!fs.statSync(ompBinary).isFile()) {
			missing.push(`omp binary path is not a file: ${ompBinary}`);
		} else {
			try {
				fs.accessSync(ompBinary, fs.constants.X_OK);
			} catch {
				missing.push(`omp binary at ${ompBinary} is not executable (fix with: chmod +x ${ompBinary})`);
			}
		}

		const model = typeof options.model === "string" ? options.model : this.defaultModel;
		const authEnvVar = authEnvVarFor(model);
		// A locally served endpoint authenticates nothing, so a key it never reads is not a
		// requirement a run can be missing. An API key is also not required when a host auth
		// DB holds an OAuth credential for the model's provider — omp reads it from
		// ~/.omp/agent/agent.db inside the container.
		if (!isLocalInferenceModel(model) && !resolveApiKey(options, authEnvVar)) {
			const authDb = resolveOmpAuthDb();
			if (!authDb) {
				missing.push(
					`omp requires auth for ${model}; set $${authEnvVar}, pass --omp-api-key <key>, or log in with: omp /login`,
				);
			} else {
				try {
					await requireStagedAuthCanServeToken(model, true, authDb);
				} catch (err) {
					missing.push(`staged auth DB at ${authDb}: ${errorMessage(err)} (log in first with: omp /login)`);
				}
			}
		}

		// A locally served endpoint the container cannot reach fails every trial the same
		// way, so the run refuses here with the command that publishes it.
		const endpointRefusal = await localEndpointRefusal(model);
		if (endpointRefusal) missing.push(endpointRefusal);

		if (missing.length > 0) {
			return {
				ok: false,
				reason: `Missing requirements for omp harness: ${missing.join(", ")}`,
				missingRequirements: missing,
			};
		}
		return { ok: true };
	}

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		const ompBinary = resolveOmpBinary(context.args);
		if (!ompBinary || !fs.existsSync(ompBinary)) {
			errors.push("omp CLI binary unavailable; pass --omp-binary or install omp on PATH");
		} else if (!fs.statSync(ompBinary).isFile()) {
			errors.push(`omp CLI path is not a file: ${ompBinary}`);
		}

		const authEnvVar = authEnvVarFor(context.model);
		if (!isLocalInferenceModel(context.model) && !resolveApiKey(context.args, authEnvVar)) {
			const authDb = resolveOmpAuthDb();
			if (!authDb) {
				errors.push(
					`omp requires auth for ${context.model}; set $${authEnvVar}, pass --omp-api-key <key>, or log in with: omp /login`,
				);
			}
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	async stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> {
		const [root, arm, model, options] =
			"targetDir" in context
				? ([context.targetDir, context.variant.name, context.variant.model, context.options ?? {}] as const)
				: ([context.assetsDir, context.system, context.model, context.args] as const);
		stageHarnessProgram(this, programDirFor(root, this.id, arm), { model, options });
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		return { program_path: containerProgramPath(programDirFor(context.assetsDir, this.id, context.system)) };
	}
}

export const ompAdapter = new OmpAdapter();

export default ompAdapter;
