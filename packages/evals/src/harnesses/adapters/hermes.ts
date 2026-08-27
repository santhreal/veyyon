import * as fs from "node:fs";
import * as path from "node:path";
import {
	type SystemJobConfigContext,
	type SystemPreflightContext,
	type SystemPreflightResult,
	type SystemStageContext,
	sanitizeVariantName,
} from "../../core";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";

export class HermesAdapter implements HarnessAdapter {
	readonly name = "hermes";
	readonly displayName = "Hermes";
	readonly description = "Hermes agent native replay and compaction execution.";
	readonly flags: readonly string[] = ["hermes-auth"];
	readonly defaultModel = "google-antigravity/gemini-3.6-flash";

	readonly capabilities: HarnessCapabilities = {
		replay: true,
		compaction: true,
		armAttachments: false,
		promptOverrides: false,
	};

	readonly backends = {
		pier: {
			agentImportPath: "hermes_agent:HermesAgent",
			containerAssetsDir: "/opt/hermes-bench",
		},
	} as const;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const hermesAuth =
			typeof options["hermes-auth"] === "string"
				? path.resolve(options["hermes-auth"])
				: typeof options.hermesAuth === "string"
					? path.resolve(options.hermesAuth)
					: null;

		if (!hermesAuth || !fs.existsSync(hermesAuth)) {
			missing.push("Hermes auth .env file (--hermes-auth)");
		} else if (!fs.statSync(hermesAuth).isFile() || fs.statSync(hermesAuth).size === 0) {
			missing.push(`Hermes auth file is empty or not a file: ${hermesAuth}`);
		}

		if (missing.length > 0) {
			return {
				ok: false,
				reason: `Missing requirements for hermes harness: ${missing.join(", ")}`,
				missingRequirements: missing,
			};
		}
		return { ok: true };
	}

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];
		const hermesAuth =
			typeof context.args["hermes-auth"] === "string" ? path.resolve(context.args["hermes-auth"]) : null;
		if (!hermesAuth || !fs.existsSync(hermesAuth)) {
			errors.push("Hermes auth unavailable; pass --hermes-auth <nonempty .env file>");
		} else if (!fs.statSync(hermesAuth).isFile() || fs.statSync(hermesAuth).size === 0) {
			errors.push(`Hermes auth file is empty or not a file: ${hermesAuth}`);
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

			const hermesAuth =
				typeof options["hermes-auth"] === "string"
					? path.resolve(options["hermes-auth"])
					: typeof options.hermesAuth === "string"
						? path.resolve(options.hermesAuth)
						: null;
			if (hermesAuth && fs.existsSync(hermesAuth)) {
				fs.copyFileSync(hermesAuth, path.join(destDir, "hermes.env"));
				fs.chmodSync(path.join(destDir, "hermes.env"), 0o600);
			}
			return;
		}

		// SystemStageContext
		const hermesAuth =
			typeof context.args["hermes-auth"] === "string" ? path.resolve(context.args["hermes-auth"]) : null;
		if (hermesAuth && fs.existsSync(hermesAuth)) {
			fs.copyFileSync(hermesAuth, path.join(context.assetsDir, "hermes.env"));
			fs.chmodSync(path.join(context.assetsDir, "hermes.env"), 0o600);
		}
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		const kwargs: Record<string, unknown> = {
			auth_path: path.join(context.assetsDir, "hermes.env"),
		};
		if (context.replayPath) {
			kwargs.replay_path = context.replayPath;
		}
		return kwargs;
	}
}

export const hermesAdapter = new HermesAdapter();
