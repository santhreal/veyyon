import { errorMessage } from "@veyyon/utils";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	SystemAdapter,
	SystemJobConfigContext,
	SystemPreflightContext,
	SystemPreflightResult,
	SystemStageContext,
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
		"opencode-go": "https://opencode.ai/zen/go/v1",
		"opencode-zen": "https://opencode.ai/zen/v1",
	};
	const providerApis: Record<string, string> = {
		"opencode-go": "openai-completions",
		"opencode-zen": "openai-completions",
	};
	for (const line of refreshJson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let data: { models?: Array<Record<string, unknown>> };
		try {
			data = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const match = data.models?.find(m => m.selector === modelSelector || m.id === modelId);
		if (!match) continue;
		const entry: Record<string, unknown> = { id: match.id };
		if (typeof match.name === "string") entry.name = match.name;
		if (typeof match.contextWindow === "number") entry.contextWindow = match.contextWindow;
		if (typeof match.maxTokens === "number") entry.maxTokens = match.maxTokens;
		if (typeof match.reasoning === "boolean") entry.reasoning = match.reasoning;
		if (Array.isArray(match.input) && match.input.length > 0) entry.input = match.input;
		if (match.cost && typeof match.cost === "object") entry.cost = match.cost;
		// Minimal YAML serializer — the structure is flat and predictable.
		const baseUrl = providerBaseUrls[provider] ?? "";
		const api = providerApis[provider] ?? "openai-completions";
		let yml = `providers:\n  ${provider}:\n    apiKey: ${apiKey}\n`;
		if (baseUrl) yml += `    baseUrl: ${baseUrl}\n`;
		if (api) yml += `    api: ${api}\n`;
		yml += "    models:\n";
		yml += `      - id: ${entry.id}\n`;
		if (entry.name) yml += `        name: ${String(entry.name)}\n`;
		if (entry.contextWindow) yml += `        contextWindow: ${entry.contextWindow}\n`;
		if (entry.maxTokens) yml += `        maxTokens: ${entry.maxTokens}\n`;
		if (entry.reasoning !== undefined) yml += `        reasoning: ${entry.reasoning}\n`;
		if (Array.isArray(entry.input)) {
			yml += `        input:\n${entry.input.map((i: string) => `          - ${i}`).join("\n")}\n`;
		}
		if (entry.cost && typeof entry.cost === "object") {
			const c = entry.cost as Record<string, number>;
			yml += "        cost:\n";
			for (const [k, v] of Object.entries(c)) {
				yml += `          ${k}: ${v}\n`;
			}
		}
		return yml;
	}
	return null;
}

export class OmpAdapter implements SystemAdapter {
	readonly name = "omp";
	readonly displayName = "Oh My Pi (omp)";
	readonly pierAgentImport = "omp_agent:OmpAgent";
	readonly description = "Oh My Pi (omp) CLI agent headlessly executing DeepSWE benchmark tasks.";
	readonly supportsReplay = false;
	readonly supportsCompaction = false;
	readonly supportsArmAttachments = false;
	readonly defaultModel = "opencode-go/deepseek-v4-flash";
	readonly containerAssetsDir = "/opt/omp-assets";

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		// Check for omp binary or cli.js
		const ompCli = context.args["omp-cli"] ?? context.args["omp-binary"];
		if (ompCli && !fs.existsSync(ompCli)) {
			errors.push(`specified omp CLI/binary path not found: ${ompCli}`);
		}
		const hostBun = Bun.which("bun") ?? "/usr/local/bin/bun";

		if (!fs.existsSync(hostBun)) {
			warnings.push(`bun runtime not found at ${hostBun}; staging will attempt fallback`);
		}

		// Check for OpenCode API key if running opencode route
		const opencodeKey = process.env.OPENCODE_API_KEY ?? context.args["opencode-key"];
		if (!opencodeKey && context.model.startsWith("opencode")) {
			warnings.push("OPENCODE_API_KEY environment variable is unset; trial may fail auth in container");
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	stageAssets(context: SystemStageContext): void {
		const hostBun = Bun.which("bun") ?? "/usr/local/bin/bun";
		if (fs.existsSync(hostBun)) {
			fs.copyFileSync(hostBun, path.join(context.assetsDir, "bun"));
			fs.chmodSync(path.join(context.assetsDir, "bun"), 0o755);
		}

		// Stage cli.js if supplied, or locate from ~/.omp or workspace
		const customCli = context.args["omp-cli"] ? path.resolve(context.args["omp-cli"]) : null;
		const defaultCli = path.join(context.outRoot, "assets", "cli.js");
		if (customCli && fs.existsSync(customCli)) {
			fs.copyFileSync(customCli, path.join(context.assetsDir, "cli.js"));
			fs.chmodSync(path.join(context.assetsDir, "cli.js"), 0o755);
		} else if (fs.existsSync(defaultCli)) {
			fs.copyFileSync(defaultCli, path.join(context.assetsDir, "cli.js"));
			fs.chmodSync(path.join(context.assetsDir, "cli.js"), 0o755);
		}

		// Stage opencode key
		const key = process.env.OPENCODE_API_KEY ?? context.args["opencode-key"] ?? "";
		if (key) {
			fs.writeFileSync(path.join(context.assetsDir, "opencode-key"), key.trim());
			fs.chmodSync(path.join(context.assetsDir, "opencode-key"), 0o600);
		}

		// Stage omp node_modules as a tar.gz so cli.js can resolve all imports.
		// The bundled cli.js imports @oh-my-pi/* packages and external dependencies
		// (turndown, marked, mammoth, etc.) from the top-level node_modules tree.
		// Without the full node_modules Bun fails with "Cannot find module" inside
		// the container.
		const cliSource = customCli ?? defaultCli;
		const tarPath = path.join(context.assetsDir, "omp-node-modules.tar.gz");
		if (cliSource && fs.existsSync(cliSource)) {
			// cli.js lives at <node_modules>/@oh-my-pi/pi-coding-agent/dist/cli.js;
			// the node_modules root is four levels up from the dist directory.
			const distDir = path.dirname(cliSource);
			const pkgDir = path.dirname(distDir);
			const ohMyPiDir = path.dirname(pkgDir);
			const nodeModulesDir = path.dirname(ohMyPiDir);
			const ohMyPiName = path.basename(ohMyPiDir);
			if (ohMyPiName === "@oh-my-pi" && fs.existsSync(nodeModulesDir)) {
				execFileSync("tar", ["-czf", tarPath, "-C", path.dirname(nodeModulesDir), "node_modules"], {
					stdio: ["ignore", "ignore", "inherit"],
				});
			}
		}
		// Generate a models.yml defining the eval model statically. The omp
		// binary's background discovery may not complete before model
		// resolution when --model is explicit, and omp's own `models refresh`
		// lacks the models.dev overlay that provides contextWindow/maxTokens
		// for models absent from the bundled catalog. The veyvon binary
		// (already staged at assetsDir/vey) has the overlay, so use it to
		// fetch metadata and write a models.yml the omp agent copies to
		// ~/.omp/agent/models.yml before startup.
		const veyBinary = path.join(context.assetsDir, "vey");
		const opencodeKey = process.env.OPENCODE_API_KEY ?? context.args["opencode-key"] ?? "";
		if (fs.existsSync(veyBinary) && opencodeKey && context.model.includes("/")) {
			const provider = context.model.split("/")[0];
			try {
				const refreshOutput = execFileSync(veyBinary, ["models", "refresh", provider, "--json"], {
					env: { ...process.env, OPENCODE_API_KEY: opencodeKey },
					stdio: ["ignore", "pipe", "inherit"],
					timeout: 120_000,
					maxBuffer: 10 * 1024 * 1024,
					cwd: context.assetsDir,
				}).toString("utf8");
				const modelsYml = buildModelsYml(refreshOutput, context.model, opencodeKey.trim());
				if (modelsYml) {
					fs.writeFileSync(path.join(context.assetsDir, "omp-models.yml"), modelsYml, { mode: 0o600 });
				}
			} catch (error) {
				console.warn(
					`omp: models.yml generation failed: ${errorMessage(error)}`,
				);
			}
		}
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		const kwargs: Record<string, unknown> = {
			assets_dir: context.assetsDir,
			binary_sha: context.binarySha ?? "omp-cli-js",
		};
		if (context.promptTemplatePath) {
			kwargs.prompt_template_path = context.promptTemplatePath;
		}
		return kwargs;
	}
}

export const ompAdapter = new OmpAdapter();
