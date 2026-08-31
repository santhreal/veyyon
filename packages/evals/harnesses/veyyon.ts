import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import type { SystemJobConfigContext, SystemPreflightContext, SystemPreflightResult, SystemStageContext }  from "../engine/contracts"
import { isLocalInferenceModel, localEndpointRefusal } from "../engine/local-inference-endpoint"
import { sanitizeVariantName } from "../engine/run-layout";
import { AUTH_DB_SOURCES, requireStagedAuthCanServeToken } from "../engine/auth-preflight";
import { decideAuthSeed, probeCredentialStore } from "../engine/auth-seed";
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../engine/contracts";
import { authDbPath, veyBinaryPath } from "../engine/package-paths";

export class VeyyonAdapter implements HarnessAdapter {
	readonly id = "veyyon";
	readonly displayName = "Veyyon";
	readonly description = "Main Veyyon headless agent CLI execution and replay in isolated Docker containers.";
	// `vey-binary` names the build under test. A run comparing two builds of veyyon names
	// one per run, so without the flag no invocation can measure anything but the
	// checkout's own binary. `#namedBinary` reads it wherever a build is resolved, and the
	// grammar's own `--binary` is the same instruction under its general name.
	readonly flags: readonly string[] = ["auth-db", "vey-binary"];
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
			agentImportPath: "veyyon_local:VeyyonLocal",
			sourceMount: true,
			localTarball: true,
			authGateway: true,
			requiresDocker: true,
		},
		"in-process": {},
	} as const;

	/**
	 * The build the invocation's flags named, or null when they named none.
	 *
	 * `--binary` and `--vey-binary` are the same instruction, and the declared flag is the
	 * second one, so a preflight that read only the first reported a typo in `--vey-binary`
	 * as no pin at all and measured the checkout's own build instead. `pinnedBinary` is not
	 * a flag: the executor sets it, so it is resolved where run options are read and never
	 * against an invocation's arguments.
	 */
	#namedBinary(options: Readonly<Record<string, unknown>>): string | null {
		const value = options["vey-binary"];
		if (typeof value === "string" && value !== "") return path.resolve(value);
		return null;
	}

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		if (context.backend === "in-process") {
			return { ok: true };
		}
		const options = context.options ?? {};
		const missing: string[] = [];

		const pinned = typeof options.pinnedBinary === "string" ? path.resolve(options.pinnedBinary) : null;
		const binary = this.#namedBinary(options) ?? pinned ?? veyBinaryPath();

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
				// other provider's pool, whose emptiness says nothing about this run. A locally
				// served model has no pool at all: the endpoint takes no credential, so a store
				// that can serve nothing else still serves this run.
				const model = typeof options.model === "string" ? options.model : null;
				if (model !== null && !isLocalInferenceModel(model)) {
					await requireStagedAuthCanServeToken(model, true, candidateDb);
				}
			} catch (err) {
				missing.push(`staged auth DB at ${candidateDb}: ${errorMessage(err)} (log in first with: vey /login)`);
			}
		}

		// A locally served endpoint the container cannot reach fails every trial the same way,
		// so the run refuses here with the command that publishes it.
		if (typeof options.model === "string") {
			const endpointRefusal = await localEndpointRefusal(options.model);
			if (endpointRefusal) missing.push(endpointRefusal);
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

		const binaryPath = this.#namedBinary(context.args);
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

export default veyyonAdapter;
