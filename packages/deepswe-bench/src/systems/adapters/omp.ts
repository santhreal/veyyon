import * as fs from "node:fs";
import * as path from "node:path";
import type {
	SystemAdapter,
	SystemJobConfigContext,
	SystemPreflightContext,
	SystemPreflightResult,
	SystemStageContext,
} from "../types";

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
