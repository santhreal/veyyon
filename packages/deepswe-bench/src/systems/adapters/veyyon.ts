import * as fs from "node:fs";
import * as path from "node:path";
import type {
	SystemAdapter,
	SystemJobConfigContext,
	SystemPreflightContext,
	SystemPreflightResult,
	SystemStageContext,
} from "../types";

export class VeyyonAdapter implements SystemAdapter {
	readonly name = "veyyon";
	readonly displayName = "Veyyon";
	readonly pierAgentImport = "veyyon_agent:VeyyonAgent";
	readonly description = "Main Veyyon headless agent CLI execution and replay in isolated Docker containers.";
	readonly supportsReplay = true;
	readonly supportsCompaction = true;
	readonly supportsArmAttachments = true;
	readonly defaultModel = "google-antigravity/gemini-3.5-flash";
	readonly containerAssetsDir = "/opt/veyyon-assets";

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		// The vey binary must exist when not in dry-run mode. In dry-run the
		// executor's own preflight handles this, so a missing binary is a warning
		// rather than a hard error.
		const binaryPath = context.args.binary ? path.resolve(context.args.binary) : null;
		if (binaryPath) {
			if (!fs.existsSync(binaryPath)) {
				errors.push(`pinned vey binary not found: ${binaryPath}`);
			} else if (!fs.statSync(binaryPath).isFile()) {
				errors.push(`pinned vey binary path is not a file: ${binaryPath}`);
			}
		}

		// Auth DB is staged by the executor's preflight; warn if it is missing so
		// the operator knows before containers start.
		const authDb = context.args["auth-db"] ?? null;
		if (authDb && !fs.existsSync(authDb)) {
			warnings.push(`auth DB not found at ${authDb}; executor will seed a fresh one`);
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	stageAssets(_context: SystemStageContext): void {
		// Veyyon binary and auth DB staging are handled via arm-staging pipeline
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		const kwargs: Record<string, unknown> = {
			arm_name: context.armName ?? (context.comparisonMode ? "baseline" : context.system),
			assets_dir: context.assetsDir,
			binary_sha: context.binarySha ?? "nosha",
		};
		if (context.promptTemplatePath) {
			kwargs.prompt_template_path = context.promptTemplatePath;
		}
		if (context.replayPath) {
			kwargs.replay_path = context.replayPath;
		}
		return kwargs;
	}
}

export const veyyonAdapter = new VeyyonAdapter();
