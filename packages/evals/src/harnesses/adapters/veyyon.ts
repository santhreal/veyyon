import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_IMPORT_PATH } from "../../backends/harbor/launch-args";
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

export class VeyyonAdapter implements HarnessAdapter, SystemAdapter {
	readonly name = "veyyon";
	readonly displayName = "Veyyon";
	readonly description = "Main Veyyon headless agent CLI execution and replay in isolated Docker containers.";
	readonly defaultModel = "google-antigravity/gemini-3.5-flash";

	readonly capabilities: HarnessCapabilities = {
		replay: true,
		compaction: true,
		armAttachments: true,
		promptOverrides: true,
	};

	readonly backends = {
		pier: {
			agentImportPath: "veyyon_agent:VeyyonAgent",
			containerAssetsDir: "/opt/veyyon-assets",
		},
		harbor: {
			agentImportPath: AGENT_IMPORT_PATH,
		},
		"in-process": {},
	} as const;

	// Backward compatibility with legacy SystemAdapter
	readonly pierAgentImport = "veyyon_agent:VeyyonAgent";
	readonly containerAssetsDir = "/opt/veyyon-assets";
	readonly supportsReplay = true;
	readonly supportsCompaction = true;
	readonly supportsArmAttachments = true;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];
		const binary = typeof options.binary === "string" ? path.resolve(options.binary) : null;
		if (binary) {
			if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
				missing.push(`pinned vey binary: ${binary}`);
			}
		}
		if (missing.length > 0) {
			return {
				ok: false,
				reason: `Missing requirements for veyyon harness: ${missing.join(", ")}`,
				missingRequirements: missing,
			};
		}
		return { ok: true };
	}

	validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		const binaryPath = context.args.binary ? path.resolve(context.args.binary as string) : null;
		if (binaryPath) {
			if (!fs.existsSync(binaryPath)) {
				errors.push(`pinned vey binary not found: ${binaryPath}`);
			} else if (!fs.statSync(binaryPath).isFile()) {
				errors.push(`pinned vey binary path is not a file: ${binaryPath}`);
			}
		}

		const authDb = typeof context.args["auth-db"] === "string" ? context.args["auth-db"] : null;
		if (authDb && !fs.existsSync(authDb)) {
			warnings.push(`auth DB not found at ${authDb}; executor will seed a fresh one`);
		}

		return { valid: errors.length === 0, errors, warnings };
	}

	async stageAssets(_context: HarnessStageContext | SystemStageContext): Promise<void> {
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
