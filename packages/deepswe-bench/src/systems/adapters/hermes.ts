import * as fs from "node:fs";
import * as path from "node:path";
import type {
	SystemAdapter,
	SystemJobConfigContext,
	SystemPreflightContext,
	SystemPreflightResult,
	SystemStageContext,
} from "../types";

export class HermesAdapter implements SystemAdapter {
	readonly name = "hermes";
	readonly displayName = "Hermes";
	readonly pierAgentImport = "hermes_agent:HermesAgent";
	readonly description = "Hermes agent native replay and compaction execution.";
	readonly supportsReplay = true;
	readonly supportsCompaction = true;
	readonly supportsArmAttachments = false;
	readonly defaultModel = "google-antigravity/gemini-3.6-flash";
	readonly containerAssetsDir = "/opt/hermes-bench";

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];
		const hermesAuth = context.args["hermes-auth"] ? path.resolve(context.args["hermes-auth"]) : null;
		if (!hermesAuth || !fs.existsSync(hermesAuth)) {
			errors.push("Hermes auth unavailable; pass --hermes-auth <nonempty .env file>");
		} else if (!fs.statSync(hermesAuth).isFile() || fs.statSync(hermesAuth).size === 0) {
			errors.push(`Hermes auth file is empty or not a file: ${hermesAuth}`);
		}
		return { valid: errors.length === 0, errors, warnings };
	}

	stageAssets(context: SystemStageContext): void {
		const hermesAuth = context.args["hermes-auth"] ? path.resolve(context.args["hermes-auth"]) : null;
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
