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

export class HermesAdapter implements HarnessAdapter, SystemAdapter {
	readonly name = "hermes";
	readonly displayName = "Hermes";
	readonly description = "Hermes agent native replay and compaction execution.";
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

	// Backward compatibility with legacy SystemAdapter
	readonly pierAgentImport = "hermes_agent:HermesAgent";
	readonly containerAssetsDir = "/opt/hermes-bench";
	readonly supportsReplay = true;
	readonly supportsCompaction = true;
	readonly supportsArmAttachments = false;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const hermesAuth = typeof options["hermes-auth"] === "string" ? path.resolve(options["hermes-auth"]) : null;

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
			const hermesAuth = typeof options["hermes-auth"] === "string" ? path.resolve(options["hermes-auth"]) : null;
			if (hermesAuth && fs.existsSync(hermesAuth)) {
				fs.copyFileSync(hermesAuth, path.join(context.targetDir, "hermes.env"));
				fs.chmodSync(path.join(context.targetDir, "hermes.env"), 0o600);
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
