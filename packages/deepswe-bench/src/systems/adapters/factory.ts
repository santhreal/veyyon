import * as fs from "node:fs";
import * as path from "node:path";
import type {
	SystemAdapter,
	SystemJobConfigContext,
	SystemPreflightContext,
	SystemPreflightResult,
	SystemStageContext,
} from "../types";

export class FactoryAdapter implements SystemAdapter {
	readonly name = "factory";
	readonly displayName = "Factory";
	readonly pierAgentImport = "factory_agent:FactoryAgent";
	readonly description = "Factory CLI (droid) execution and compaction replay.";
	readonly supportsReplay = true;
	readonly supportsCompaction = true;
	readonly supportsArmAttachments = false;
	readonly defaultModel = "google-antigravity/gemini-3.6-flash";
	readonly containerAssetsDir = "/opt/factory-assets";

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];
		const factoryBinary = context.args["factory-binary"]
			? path.resolve(context.args["factory-binary"])
			: (Bun.which("droid") ?? null);

		if (!factoryBinary || !fs.existsSync(factoryBinary)) {
			errors.push("Factory CLI binary unavailable; pass --factory-binary or install droid on PATH");
		} else if (!fs.statSync(factoryBinary).isFile()) {
			errors.push(`Factory CLI path is not a file: ${factoryBinary}`);
		}

		const factoryAuth = context.args["factory-auth"] ? path.resolve(context.args["factory-auth"]) : null;
		if (!factoryAuth || !fs.existsSync(factoryAuth)) {
			errors.push("Factory auth unavailable; pass --factory-auth <nonempty API-key file>");
		} else if (!fs.statSync(factoryAuth).isFile() || fs.statSync(factoryAuth).size === 0) {
			errors.push(`Factory auth file is empty or not a file: ${factoryAuth}`);
		}

		if (context.args["factory-settings"]) {
			const settings = path.resolve(context.args["factory-settings"]);
			if (!fs.existsSync(settings) || !fs.statSync(settings).isFile()) {
				errors.push(`Factory settings path was supplied but is invalid: ${settings}`);
			}
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	stageAssets(context: SystemStageContext): void {
		const factoryBinary = context.args["factory-binary"]
			? path.resolve(context.args["factory-binary"])
			: (Bun.which("droid") ?? null);
		if (factoryBinary && fs.existsSync(factoryBinary)) {
			fs.copyFileSync(factoryBinary, path.join(context.assetsDir, "droid"));
			fs.chmodSync(path.join(context.assetsDir, "droid"), 0o755);
		}

		const factoryAuth = context.args["factory-auth"] ? path.resolve(context.args["factory-auth"]) : null;
		if (factoryAuth && fs.existsSync(factoryAuth)) {
			fs.copyFileSync(factoryAuth, path.join(context.assetsDir, "factory-api-key"));
			fs.chmodSync(path.join(context.assetsDir, "factory-api-key"), 0o600);
		}

		if (context.args["factory-settings"]) {
			const settings = path.resolve(context.args["factory-settings"]);
			if (fs.existsSync(settings)) {
				fs.copyFileSync(settings, path.join(context.assetsDir, "settings.json"));
			}
		}
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		const kwargs: Record<string, unknown> = {
			assets_dir: context.assetsDir,
			binary_sha: context.binarySha ?? "nosha",
		};
		if (context.replayPath) {
			kwargs.replay_path = context.replayPath;
		}
		return kwargs;
	}
}

export const factoryAdapter = new FactoryAdapter();
