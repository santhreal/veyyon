import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, errorMessage, logger } from "@veyyon/utils";
import {
	CONTAINER_PROGRAM_VERSION,
	type ContainerProgramContext,
	containerLocalEndpointEnv,
	containerProgramPath,
	isLocalInferenceModel,
	localEndpointAllowedDomains,
	localEndpointRefusal,
	type ProgramFile,
	programDirFor,
	type StagedProgram,
	type SystemJobConfigContext,
	type SystemPreflightContext,
	type SystemPreflightResult,
	type SystemStageContext,
	stageHarnessProgram,
} from "../../core";
import { parseModelId } from "../../core/trial-model";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";
import { veyBinaryPath } from "../../paths";

/** Where the staged omp files land inside a task container. */
const CONTAINER_DIR = "/opt/omp-assets";

/**
 * Where omp writes its session transcripts inside the container. The assets directory is
 * root-owned, so the agent user cannot create a directory in it; the container's own `/tmp`
 * is writable and is discarded with the container.
 */
const SESSION_DIR = "/tmp/omp-sessions";

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
function buildModelsYml(refreshJson: string, modelSelector: string, apiKey: string): string | null {
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

	for (const line of refreshJson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as {
				id?: string;
				name?: string;
				reasoning?: boolean;
				input?: number;
				output?: number;
				contextWindow?: number;
				maxTokens?: number;
			};
			if (entry.id !== modelId && entry.name !== modelId) continue;
			const contextWindow = entry.contextWindow ?? entry.input ?? 131_072;
			const maxTokens = entry.maxTokens ?? entry.output ?? 8192;
			const reasoning = entry.reasoning ?? false;
			const baseUrl = providerBaseUrls[provider] ?? "https://opencode.ai/zen/v1";
			const api = providerApis[provider] ?? "openai-compatible";

			return [
				"providers:",
				`  ${provider}:`,
				`    baseUrl: ${JSON.stringify(baseUrl)}`,
				`    apiKey: ${JSON.stringify(apiKey)}`,
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
		} catch {
			/* skip unparseable line */
		}
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
function ompModelsYml(model: string, apiKey: string, options: Readonly<Record<string, unknown>>): string | null {
	if (!apiKey || isLocalInferenceModel(model)) return null;
	const flag = options.binary ?? options["vey-binary"];
	const candidate = typeof flag === "string" ? path.resolve(flag) : veyBinaryPath();
	const veyBinary = fs.existsSync(candidate) ? candidate : null;
	if (!veyBinary) return null;
	const provider = parseModelId(model).provider;
	try {
		const refreshOutput = execFileSync(veyBinary, ["models", "refresh", provider, "--json"], {
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, [authEnvVarFor(model)]: apiKey },
		});
		return buildModelsYml(refreshOutput, model, apiKey);
	} catch (err) {
		logger.warn(`warning: failed to build models.yml for omp via 'vey models refresh': ${errorMessage(err)}`);
		return null;
	}
}

export class OmpAdapter implements HarnessAdapter {
	readonly name = "omp";
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
		},
	} as const;

	/**
	 * The one declaration of an omp trial: the compiled binary, the provider key, the
	 * optional static catalog, the headless invocation and where its transcripts land.
	 *
	 * Pier and Harbor both stage this and both hand it to the same executor, so an asset this
	 * names is an asset the container agent reads. The provider key travels in `omp.env`,
	 * never on the command line.
	 */
	containerProgram(context: ContainerProgramContext): StagedProgram {
		const options = context.options;
		const model = context.model || this.defaultModel;
		const authEnvVar = authEnvVarFor(model);
		const apiKey = resolveApiKey(options, authEnvVar) ?? "";
		const binary = resolveOmpBinary(options);
		const modelsYml = ompModelsYml(model, apiKey, options);
		const localEndpoint = containerLocalEndpointEnv(model);

		const files: ProgramFile[] = [];
		if (binary) files.push({ file: "omp", source: { copy: binary }, mode: 0o755 });
		const envLines = [`${authEnvVar}=${apiKey}`, `OPENCODE_API_KEY=${apiKey}`];
		for (const [key, value] of Object.entries(localEndpoint ?? {})) envLines.push(`${key}=${value}`);
		files.push({
			file: "omp.env",
			source: { text: `${envLines.join("\n")}\n` },
			mode: 0o600,
		});
		if (modelsYml) files.push({ file: "models.yml", source: { text: modelsYml } });

		return {
			program: {
				version: CONTAINER_PROGRAM_VERSION,
				harness: this.name,
				containerDir: CONTAINER_DIR,
				assets: [
					{ file: "omp", dest: `${CONTAINER_DIR}/omp`, mode: "0755" },
					{ file: "omp.env", dest: `${CONTAINER_DIR}/omp.env`, mode: "0600" },
					{ file: "models.yml", dest: `${CONTAINER_DIR}/models.yml`, optional: true },
				],
				setup: [
					`mkdir -p ${SESSION_DIR} ~/.omp/agent`,
					`if [ -f ${CONTAINER_DIR}/models.yml ]; then cp ${CONTAINER_DIR}/models.yml ~/.omp/agent/models.yml; fi`,
				],
				// --mode json streams NDJSON events (thinking deltas, tool calls, text) to
				// stdout instead of buffering the result until exit, so a long trial is
				// observable in the log while it runs.
				command: `{{assets}}/omp --model {{model}} --auto-approve --print --mode json --session-dir ${SESSION_DIR} {{instruction}}`,
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
		// requirement a run can be missing.
		if (!isLocalInferenceModel(model) && !resolveApiKey(options, authEnvVar)) {
			missing.push(`omp requires an API key for ${model}; set $${authEnvVar} or pass --omp-api-key <key>`);
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
			errors.push(`omp requires an API key for ${context.model}; set $${authEnvVar} or pass --omp-api-key <key>`);
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	async stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> {
		const [root, arm, model, options] =
			"targetDir" in context
				? ([context.targetDir, context.variant.name, context.variant.model, context.options ?? {}] as const)
				: ([context.assetsDir, context.system, context.model, context.args] as const);
		stageHarnessProgram(this, programDirFor(root, this.name, arm), { model, options });
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		return { program_path: containerProgramPath(programDirFor(context.assetsDir, this.name, context.system)) };
	}
}

export const ompAdapter = new OmpAdapter();
