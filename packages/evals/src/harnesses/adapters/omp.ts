import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, errorMessage, logger } from "@veyyon/utils";
import { parseModelId } from "../../core/trial-model";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";
import { veyBinaryPath } from "../../paths";
import {
	type SystemAdapter,
	type SystemJobConfigContext,
	type SystemPreflightContext,
	type SystemPreflightResult,
	type SystemStageContext,
	sanitizeVariantName,
} from "../types";

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

export class OmpAdapter implements HarnessAdapter, SystemAdapter {
	readonly name = "omp";
	readonly displayName = "Oh My Pi (omp)";
	readonly description = "Oh My Pi (omp) CLI agent headlessly executing DeepSWE benchmark tasks.";
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
			containerAssetsDir: "/opt/omp-assets",
		},
	} as const;

	// Backward compatibility with legacy SystemAdapter
	readonly pierAgentImport = "omp_agent:OmpAgent";
	readonly containerAssetsDir = "/opt/omp-assets";
	readonly supportsReplay = false;
	readonly supportsCompaction = false;
	readonly supportsArmAttachments = false;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const ompBinary =
			typeof options["omp-binary"] === "string"
				? path.resolve(options["omp-binary"])
				: typeof options.ompBinary === "string"
					? path.resolve(options.ompBinary)
					: ($which("omp") ?? null);

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
		const provider = parseModelId(model).provider;
		const authEnvVar = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		const explicitKey =
			typeof options["omp-api-key"] === "string"
				? options["omp-api-key"]
				: typeof options.ompApiKey === "string"
					? options.ompApiKey
					: null;
		const envKey = process.env[authEnvVar] ?? process.env.OPENCODE_API_KEY ?? null;
		if (!explicitKey && !envKey) {
			missing.push(`omp requires an API key for ${model}; set $${authEnvVar} or pass --omp-api-key <key>`);
		}

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

		const ompBinary =
			typeof context.args["omp-binary"] === "string"
				? path.resolve(context.args["omp-binary"])
				: (Bun.which("omp") ?? null);

		if (!ompBinary || !fs.existsSync(ompBinary)) {
			errors.push("omp CLI binary unavailable; pass --omp-binary or install omp on PATH");
		} else if (!fs.statSync(ompBinary).isFile()) {
			errors.push(`omp CLI path is not a file: ${ompBinary}`);
		}

		const slashIndex = context.model.indexOf("/");
		const provider = slashIndex > 0 ? context.model.slice(0, slashIndex) : context.model;
		const authEnvVar = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		const explicitKey = typeof context.args["omp-api-key"] === "string" ? context.args["omp-api-key"] : null;
		const envKey = process.env[authEnvVar] ?? process.env.OPENCODE_API_KEY ?? null;
		if (!explicitKey && !envKey) {
			errors.push(`omp requires an API key for ${context.model}; set $${authEnvVar} or pass --omp-api-key <key>`);
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	async stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> {
		if ("targetDir" in context) {
			// HarnessStageContext
			const options = context.options ?? {};
			const variantKey = sanitizeVariantName(context.variant.name);
			const destDir = path.join(context.targetDir, variantKey);
			fs.mkdirSync(destDir, { recursive: true });

			const ompBinary =
				typeof options["omp-binary"] === "string"
					? path.resolve(options["omp-binary"])
					: typeof options.ompBinary === "string"
						? path.resolve(options.ompBinary)
						: ($which("omp") ?? null);
			if (ompBinary && fs.existsSync(ompBinary)) {
				fs.copyFileSync(ompBinary, path.join(destDir, "omp"));
				fs.chmodSync(path.join(destDir, "omp"), 0o755);
			}

			const model = context.variant.model || (typeof options.model === "string" ? options.model : this.defaultModel);
			const provider = parseModelId(model).provider;
			const authEnvVar = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			const apiKey =
				(typeof options["omp-api-key"] === "string" ? options["omp-api-key"] : null) ??
				(typeof options.ompApiKey === "string" ? options.ompApiKey : null) ??
				process.env[authEnvVar] ??
				process.env.OPENCODE_API_KEY ??
				"";

			if (apiKey) {
				const envContent = [`${authEnvVar}=${apiKey}`, `OPENCODE_API_KEY=${apiKey}`, ""].join("\n");
				fs.writeFileSync(path.join(destDir, "omp.env"), envContent);
				fs.chmodSync(path.join(destDir, "omp.env"), 0o600);
			}

			const veyBinary =
				typeof options.binary === "string"
					? path.resolve(options.binary)
					: typeof options["vey-binary"] === "string"
						? path.resolve(options["vey-binary"])
						: path.join(context.targetDir, "vey");
			const effectiveVeyBinary = fs.existsSync(veyBinary) ? veyBinary : veyBinaryPath();
			if (fs.existsSync(effectiveVeyBinary) && apiKey) {
				try {
					const refreshOutput = execFileSync(effectiveVeyBinary, ["models", "refresh", provider, "--json"], {
						encoding: "utf8",
						timeout: 30_000,
						env: { ...process.env, [authEnvVar]: apiKey },
					});
					const modelsYml = buildModelsYml(refreshOutput, model, apiKey);
					if (modelsYml) {
						fs.writeFileSync(path.join(destDir, "models.yml"), modelsYml);
					}
				} catch (err) {
					logger.warn(
						`warning: failed to build models.yml for omp via 'vey models refresh': ${errorMessage(err)}`,
					);
				}
			}
			return;
		}

		// SystemStageContext
		const ompBinary =
			typeof context.args["omp-binary"] === "string"
				? path.resolve(context.args["omp-binary"])
				: ($which("omp") ?? null);
		if (ompBinary && fs.existsSync(ompBinary)) {
			fs.copyFileSync(ompBinary, path.join(context.assetsDir, "omp"));
			fs.chmodSync(path.join(context.assetsDir, "omp"), 0o755);
		}

		const slashIndex = context.model.indexOf("/");
		const provider = slashIndex > 0 ? context.model.slice(0, slashIndex) : context.model;
		const authEnvVar = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		const apiKey =
			(typeof context.args["omp-api-key"] === "string" ? context.args["omp-api-key"] : null) ??
			process.env[authEnvVar] ??
			process.env.OPENCODE_API_KEY ??
			"";

		if (apiKey) {
			const envContent = [`${authEnvVar}=${apiKey}`, `OPENCODE_API_KEY=${apiKey}`, ""].join("\n");
			fs.writeFileSync(path.join(context.assetsDir, "omp.env"), envContent);
			fs.chmodSync(path.join(context.assetsDir, "omp.env"), 0o600);
		}

		const veyBinary = path.join(context.assetsDir, "vey");
		if (fs.existsSync(veyBinary) && apiKey) {
			try {
				const refreshOutput = execFileSync(veyBinary, ["models", "refresh", provider, "--json"], {
					encoding: "utf8",
					timeout: 30_000,
					env: { ...process.env, [authEnvVar]: apiKey },
				});
				const modelsYml = buildModelsYml(refreshOutput, context.model, apiKey);
				if (modelsYml) {
					fs.writeFileSync(path.join(context.assetsDir, "models.yml"), modelsYml);
				}
			} catch (err) {
				logger.warn(`warning: failed to build models.yml for omp via 'vey models refresh': ${errorMessage(err)}`);
			}
		}
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		return {
			assets_dir: context.assetsDir,
			auth_path: path.join(context.assetsDir, "omp.env"),
		};
	}
}

export const ompAdapter = new OmpAdapter();
