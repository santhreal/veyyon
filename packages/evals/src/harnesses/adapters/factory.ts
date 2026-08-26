import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@veyyon/utils";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";
import {
	type SystemJobConfigContext,
	type SystemPreflightContext,
	type SystemPreflightResult,
	type SystemStageContext,
	sanitizeVariantName,
} from "../types";

export class FactoryAdapter implements HarnessAdapter {
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

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const factoryBinary =
			typeof options["factory-binary"] === "string"
				? path.resolve(options["factory-binary"])
				: typeof options.factoryBinary === "string"
					? path.resolve(options.factoryBinary)
					: ($which("droid") ?? null);

		if (!factoryBinary || !fs.existsSync(factoryBinary)) {
			missing.push("Factory CLI binary (droid on PATH or --factory-binary)");
		} else if (!fs.statSync(factoryBinary).isFile()) {
			missing.push(`Factory CLI path is not a file: ${factoryBinary}`);
		} else {
			try {
				fs.accessSync(factoryBinary, fs.constants.X_OK);
			} catch {
				missing.push(`Factory CLI at ${factoryBinary} is not executable (fix with: chmod +x ${factoryBinary})`);
			}
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
				: ($which("droid") ?? null);
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
			const variantKey = sanitizeVariantName(context.variant.name);
			const destDir = path.join(context.targetDir, variantKey);
			fs.mkdirSync(destDir, { recursive: true });

			const factoryBinary =
				typeof options["factory-binary"] === "string"
					? path.resolve(options["factory-binary"])
					: typeof options.factoryBinary === "string"
						? path.resolve(options.factoryBinary)
						: ($which("droid") ?? null);
			if (factoryBinary && fs.existsSync(factoryBinary)) {
				fs.copyFileSync(factoryBinary, path.join(destDir, "droid"));
				fs.chmodSync(path.join(destDir, "droid"), 0o755);
			}

			const factoryAuth =
				typeof options["factory-auth"] === "string"
					? path.resolve(options["factory-auth"])
					: typeof options.factoryAuth === "string"
						? path.resolve(options.factoryAuth)
						: null;
			if (factoryAuth && fs.existsSync(factoryAuth)) {
				fs.copyFileSync(factoryAuth, path.join(destDir, "factory-api-key"));
				fs.chmodSync(path.join(destDir, "factory-api-key"), 0o600);
			}

			const settingsPath =
				context.variant.configPath ||
				(typeof options["factory-settings"] === "string" ? path.resolve(options["factory-settings"]) : null);
			if (settingsPath && fs.existsSync(settingsPath)) {
				fs.copyFileSync(settingsPath, path.join(destDir, "settings.json"));
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
