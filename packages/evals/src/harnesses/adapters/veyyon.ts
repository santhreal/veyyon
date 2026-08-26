import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { AGENT_IMPORT_PATH } from "../../backends/harbor/launch-args";
import { AUTH_DB_SOURCES, requireStagedAuthCanServeToken } from "../../core/auth-preflight";
import { decideAuthSeed, probeCredentialStore } from "../../core/auth-seed";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";
import { authDbPath, veyBinaryPath } from "../../paths";
import {
	type SystemJobConfigContext,
	type SystemPreflightContext,
	type SystemPreflightResult,
	type SystemStageContext,
	sanitizeVariantName,
} from "../types";

export class VeyyonAdapter implements HarnessAdapter {
	readonly name = "veyyon";
	readonly displayName = "Veyyon";
	readonly description = "Main Veyyon headless agent CLI execution and replay in isolated Docker containers.";
	// Veyyon drives any provider-qualified model the run names, so it declares no
	// default: a default here decided which model an unspecified run measured, and the
	// arm's name never said which one. `resolveTrialModel` refuses instead.
	readonly defaultModel = null;

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
			agentName: "veyyon",
			agentImportPath: AGENT_IMPORT_PATH,
			sourceMount: true,
			localTarball: true,
			authGateway: true,
			requiresDocker: true,
		},
		"in-process": {},
	} as const;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		if (context.backend === "in-process") {
			return { ok: true };
		}
		const options = context.options ?? {};
		const missing: string[] = [];

		const binary =
			typeof options.binary === "string"
				? path.resolve(options.binary)
				: typeof options["vey-binary"] === "string"
					? path.resolve(options["vey-binary"])
					: typeof options.pinnedBinary === "string"
						? path.resolve(options.pinnedBinary)
						: veyBinaryPath();

		if (!fs.existsSync(binary)) {
			missing.push(
				`missing vey binary at ${binary} (build with: bun --cwd=packages/coding-agent scripts/build-binary.ts)`,
			);
		} else if (!fs.statSync(binary).isFile()) {
			missing.push(`vey binary path is not a file: ${binary}`);
		} else {
			try {
				fs.accessSync(binary, fs.constants.X_OK);
			} catch {
				missing.push(`vey binary at ${binary} is not executable (fix with: chmod +x ${binary})`);
			}
		}

		const authDb =
			typeof options["auth-db"] === "string"
				? path.resolve(options["auth-db"])
				: typeof options.authDb === "string"
					? path.resolve(options.authDb)
					: authDbPath();
		const mtimeOf = (p: string): number | undefined => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : undefined);
		const authDecision = decideAuthSeed(AUTH_DB_SOURCES, authDb, mtimeOf, probeCredentialStore);
		const candidateDb =
			fs.existsSync(authDb) && probeCredentialStore(authDb) === undefined
				? authDb
				: authDecision.kind !== "missing"
					? authDecision.source
					: null;

		if (!candidateDb) {
			missing.push(
				`credential store: no agent.db at any of ${AUTH_DB_SOURCES.join(", ")} (log in first with: vey /login)`,
			);
		} else {
			try {
				// Preflight probes the credential the run's model needs. With no model named
				// there is nothing to probe, so the probe is skipped rather than aimed at some
				// other provider's pool, whose emptiness says nothing about this run.
				const model = typeof options.model === "string" ? options.model : null;
				if (model !== null) await requireStagedAuthCanServeToken(model, true, candidateDb);
			} catch (err) {
				missing.push(`staged auth DB at ${candidateDb}: ${errorMessage(err)} (log in first with: vey /login)`);
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

	async stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> {
		if ("targetDir" in context) {
			const variantKey = sanitizeVariantName(context.variant.name);
			const destDir = path.join(context.targetDir, variantKey);
			fs.mkdirSync(destDir, { recursive: true });
			// Veyyon binary and auth DB staging are handled via arm-staging pipeline
			return;
		}
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
