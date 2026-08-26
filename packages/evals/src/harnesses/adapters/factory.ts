import * as fs from "node:fs";
import * as path from "node:path";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";
import type {
	SystemAdapter,
	SystemJobConfigContext,
	SystemPreflightContext,
	SystemPreflightResult,
	SystemStageContext,
} from "../types";

export class FactoryAdapter implements HarnessAdapter, SystemAdapter {
	readonly name = "factory";
	readonly displayName = "Factory";
	readonly description = "Factory CLI (droid) execution and compaction replay.";
	readonly defaultModel = "google-antigravity/gemini-3.6-flash";

	readonly capabilities: HarnessCapabilities = {
		replay: true,
		compaction: true,
		armAttachments: false,
		promptOverrides: false,
	};

	readonly backends = {
		pier: {
			agentImportPath: "factory_agent:FactoryAgent",
			containerAssetsDir: "/opt/factory-assets",
		},
	} as const;

	// Backward compatibility with legacy SystemAdapter
	readonly pierAgentImport = "factory_agent:FactoryAgent";
	readonly containerAssetsDir = "/opt/factory-assets";
	readonly supportsReplay = true;
	readonly supportsCompaction = true;
	readonly supportsArmAttachments = false;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const factoryBinary =
			typeof options["factory-binary"] === "string"
				? path.resolve(options["factory-binary"])
				: (Bun.which("droid") ?? null);

		if (!factoryBinary || !fs.existsSync(factoryBinary)) {
			missing.push("Factory CLI binary (droid on PATH or --factory-binary)");
		} else if (!fs.statSync(factoryBinary).isFile()) {
			missing.push(`Factory CLI path is not a file: ${factoryBinary}`);
		}

		const factoryAuth = typeof options["factory-auth"] === "string" ? path.resolve(options["factory-auth"]) : null;
		if (!factoryAuth || !fs.existsSync(factoryAuth)) {
			missing.push("Factory auth file (--factory-auth)");
		} else if (!fs.statSync(factoryAuth).isFile() || fs.statSync(factoryAuth).size === 0) {
			missing.push(`Factory auth file is empty or not a file: ${factoryAuth}`);
		}

		if (missing.length > 0) {
			return {
				ok: false,
				reason: `Missing requirements for factory harness: ${missing.join(", ")}`,
				missingRequirements: missing,
			};
		}
		return { ok: true };
	}

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];
		const factoryBinary =
			typeof context.args["factory-binary"] === "string"
				? path.resolve(context.args["factory-binary"])
				: (Bun.which("droid") ?? null);

		if (!factoryBinary || !fs.existsSync(factoryBinary)) {
			errors.push("Factory CLI binary unavailable; pass --factory-binary or install droid on PATH");
		} else if (!fs.statSync(factoryBinary).isFile()) {
			errors.push(`Factory CLI path is not a file: ${factoryBinary}`);
		}

		const factoryAuth =
			typeof context.args["factory-auth"] === "string" ? path.resolve(context.args["factory-auth"]) : null;
		if (!factoryAuth || !fs.existsSync(factoryAuth)) {
			errors.push("Factory auth unavailable; pass --factory-auth <nonempty API-key file>");
		} else if (!fs.statSync(factoryAuth).isFile() || fs.statSync(factoryAuth).size === 0) {
			errors.push(`Factory auth file is empty or not a file: ${factoryAuth}`);
		}

		if (context.args["factory-settings"]) {
			const settings = path.resolve(context.args["factory-settings"] as string);
			if (!fs.existsSync(settings) || !fs.statSync(settings).isFile()) {
				errors.push(`Factory settings path was supplied but is invalid: ${settings}`);
			}
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	async stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> {
		if ("targetDir" in context) {
			// HarnessStageContext
			const options = context.options ?? {};
			const factoryBinary =
				typeof options["factory-binary"] === "string"
					? path.resolve(options["factory-binary"])
					: (Bun.which("droid") ?? null);
			if (factoryBinary && fs.existsSync(factoryBinary)) {
				fs.copyFileSync(factoryBinary, path.join(context.targetDir, "droid"));
				fs.chmodSync(path.join(context.targetDir, "droid"), 0o755);
			}

			const factoryAuth = typeof options["factory-auth"] === "string" ? path.resolve(options["factory-auth"]) : null;
			if (factoryAuth && fs.existsSync(factoryAuth)) {
				fs.copyFileSync(factoryAuth, path.join(context.targetDir, "factory-api-key"));
				fs.chmodSync(path.join(context.targetDir, "factory-api-key"), 0o600);
			}
			return;
		}

		// SystemStageContext
		const factoryBinary =
			typeof context.args["factory-binary"] === "string"
				? path.resolve(context.args["factory-binary"])
				: (Bun.which("droid") ?? null);
		if (factoryBinary && fs.existsSync(factoryBinary)) {
			fs.copyFileSync(factoryBinary, path.join(context.assetsDir, "droid"));
			fs.chmodSync(path.join(context.assetsDir, "droid"), 0o755);
		}

		const factoryAuth =
			typeof context.args["factory-auth"] === "string" ? path.resolve(context.args["factory-auth"]) : null;
		if (factoryAuth && fs.existsSync(factoryAuth)) {
			fs.copyFileSync(factoryAuth, path.join(context.assetsDir, "factory-api-key"));
			fs.chmodSync(path.join(context.assetsDir, "factory-api-key"), 0o600);
		}

		if (context.args["factory-settings"]) {
			const settings = path.resolve(context.args["factory-settings"] as string);
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
