#!/usr/bin/env bun
/**
 * DeepSWE feature bench for veyyon.
 *
 * Runs the veyyon agent on DeepSWE tasks (datacurve-ai/deep-swe, Harbor task
 * format, executed by Pier) under one or more config ARMS, and writes a
 * comparison table of verifier reward + cost/performance metrics per arm.
 *
 * An arm is a veyyon config overlay (arms/<name>.yml): the only thing that
 * differs between runs. To bench a perf-affecting feature, add an arm that
 * turns it on and one that leaves it off, then run this script. See README.md.
 *
 * Usage:
 *   bun run.ts --tasks tasks/pilot-10.txt --arms baseline,decode,full \
 *     --tasks-root /path/to/deep-swe/tasks [--limit N] [--jobs 2] [--model M] \
 *     [--repeats K] [--out runs/<label>]
 *
 * --repeats K samples every (arm, task) cell K times (default 1). LLM agents are
 * stochastic, so a single sample per cell cannot separate a real arm effect from
 * run-to-run noise. The report aggregates each cell's K samples into a pass rate
 * with a 95% Wilson confidence interval, which is what makes the comparison
 * something you can iterate on rather than a coin flip.
 *
 * Every arm runs at a pinned sampling temperature (0, greedy) unless it sets its
 * own, so --repeats measures a stable regime instead of a drifting provider
 * default; the effective temperature per arm is stamped into results.json so two
 * runs stay comparable over time.
 *
 * Prerequisites: pier (uv tool install datacurve-pier), docker, a compiled
 * binary at ../coding-agent/dist/vey (bun scripts/build-binary.ts there), and
 * google-antigravity OAuth in ~/.veyyon/shared-auth/agent.db.
 *
 * The binary, auth DB, and arm overlays are staged into <out>/assets and
 * bind-mounted into every task container at /opt/veyyon-assets (the agent
 * copies them into $HOME at run time; see pier_agent/veyyon_agent.py).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
// The arm overlays are veyyon settings, so the schema is what decides whether an
// arm names a real one. Read it directly rather than keeping a second list here
// that would go stale the first time a setting is renamed.
import { getEnumValues, getType, isSettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { readPipeText } from "@veyyon/utils";
import YAML from "yaml";
import {
	type ArmResult,
	armCanaryFailure,
	collectEmittedText,
	type EncodeHeadroom,
	effectiveTemperature,
	emptyArmResult,
	encodeHeadroom,
	finishedWithoutPatch,
	isHardError,
	jobNameOf,
	MergeRefused,
	mergeRuns,
	mostCommonAgentReason,
	NO_REWARD_ERROR,
	noRewardError,
	onPairedTasks,
	PINNED_TEMPERATURE,
	parseJobName,
	parseTaskListProvenance,
	predictedVsActual,
	providerFinishReason,
	providerQuotaStop,
	quotaStopMarker,
	type RunToMerge,
	renderReport,
	type SessionUsage,
	selectTasks,
	shouldTripCanary,
	systemPromptTeachesArgot,
	type TaskSetProvenance,
	tallyUsage,
	trialQueue,
} from "./aggregate";
import {
	type ArmInputs,
	armNamesIn,
	armSelectionError,
	computeArmFingerprint,
	findZeroIvCollisions,
} from "./arm-fingerprint";
import { formatArmPrediction, predictArmSaving } from "./arm-prediction";
import {
	type CredentialProbe,
	decideAuthPreflight,
	describeAuthPreflightFailure,
	describeExhaustedPool,
	exhaustedPoolFor,
	modelVendor,
	spentQuotaShouldAbort,
} from "./auth-preflight";
import { decideAuthSeed, probeCredentialStore, snapshotCredentialStore } from "./auth-seed";
import { resolveBinaryPin } from "./binary-pin";
import { conversationCollapsed, measureRunPrefix, PREFIX_CATEGORIES, prefixShares } from "./prefix-composition";
import { type LoadedReplayManifest, loadReplayManifest } from "./replay-manifest";
import {
	aggregateSystemComparison,
	COMPARISON_MODEL,
	COMPARISON_SYSTEMS,
	COMPARISON_TASK_LIST,
	COMPARISON_TASK_LIST_SHA256,
	type ComparisonArmResult,
	type ComparisonExecution,
	type ComparisonSystem,
	comparisonTrialsFromArmResults,
	DEFAULT_MODEL,
	type NativeCompactionEvidence,
	renderSystemComparison,
	type SystemComparison,
} from "./system-comparison";
import {
	encodeArmModelMismatch,
	encodePreambleSilentlyDropped,
	isEncodeArm,
	mistypedArmSettings,
	unknownArmSettings,
} from "./treatment-guard";
import {
	parseTaskTimeBudget,
	parseTrialTimeoutFlag,
	type ResolvedTrialTimeout,
	resolveTrialTimeout,
	truncationWarning,
} from "./trial-timeout";

const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);
const CODING_AGENT_DIR = path.resolve(BENCH_DIR, "../coding-agent");
const VEY_BINARY = path.join(CODING_AGENT_DIR, "dist", "vey");
// The bench keeps its own copy of the shared-auth DB, refreshed from the live
// store by `ensureAuthDbSeeded` on every run. The copy exists because the host
// store is not stable storage (other veyyon lanes prune it); the refresh exists
// because OAuth tokens rotate and a frozen copy authenticates nothing, and it is
// checked as well as dated because a copy that is newer but damaged used to be
// kept forever.
const AUTH_DB = path.join(BENCH_DIR, "assets", "auth-agent.db");

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
			else out[arg.slice(2)] = argv[++i] ?? "";
		}
	}
	return out;
}

function requireFile(p: string, hint: string): void {
	if (!fs.existsSync(p)) {
		console.error(`missing: ${p}\n${hint}`);
		process.exit(1);
	}
}

async function ensureBinaryUpToDate(): Promise<void> {
	const srcDir = path.join(CODING_AGENT_DIR, "src");
	let needsBuild = !fs.existsSync(VEY_BINARY);
	if (!needsBuild) {
		const binaryMtime = fs.statSync(VEY_BINARY).mtimeMs;
		function checkDir(d: string): boolean {
			for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, entry.name);
				if (entry.isDirectory()) {
					if (checkDir(p)) return true;
				} else if (entry.isFile() && fs.statSync(p).mtimeMs > binaryMtime) {
					return true;
				}
			}
			return false;
		}
		needsBuild = checkDir(srcDir);
	}
	if (needsBuild) {
		console.log("deepswe-bench: building fresh vey binary...");
		const proc = Bun.spawn(["bun", "scripts/build-binary.ts"], {
			cwd: CODING_AGENT_DIR,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) {
			console.error("failed to build vey binary");
			process.exit(1);
		}
	}
}

/**
 * Credential stores this harness will seed from, MOST canonical first.
 *
 * `~/.veyyon/shared-auth/agent.db` is where a current install writes logins (see
 * `getSharedAuthDir`). The two per-profile entries are the pre-move location,
 * kept only so an operator who has not logged in since the move can still run.
 * The order matters: those legacy files routinely survive on disk as stale
 * leftovers, and picking one over a live store hands every container credentials
 * that expired months ago.
 */
const AUTH_DB_SOURCES = [
	path.join(os.homedir(), ".veyyon", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "default", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "work", "shared-auth", "agent.db"),
];

/**
 * Copy the operator's credential store into `assets/auth-agent.db`, which every
 * task container mounts and copies into `$HOME`.
 *
 * The choice of store and the staleness rule live in `auth-seed.ts` under test;
 * this function is the effectful half. A missing store is fatal HERE rather than
 * later, because the alternative is discovering it as N unauthenticated agents
 * inside N containers.
 */
function ensureAuthDbSeeded(): void {
	fs.mkdirSync(path.join(BENCH_DIR, "assets"), { recursive: true });
	const mtimeOf = (p: string): number | undefined => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : undefined);
	const decision = decideAuthSeed(AUTH_DB_SOURCES, AUTH_DB, mtimeOf, probeCredentialStore);
	if (decision.kind === "missing") {
		console.error(
			`missing credential store: no agent.db at any of\n  ${AUTH_DB_SOURCES.join("\n  ")}\n` +
				"log in first: vey (then /login), which writes ~/.veyyon/shared-auth/agent.db",
		);
		process.exit(1);
	}
	if (decision.legacy) {
		console.warn(
			`deepswe-bench: seeding from the pre-move store ${decision.source}; ` +
				`${AUTH_DB_SOURCES[0]} does not exist, so these credentials may predate your last login`,
		);
	}
	if (decision.kind === "current") return;
	if (decision.kind === "seed") {
		console.log(`deepswe-bench: seeding auth DB from ${decision.source}`);
	} else if (decision.reason === "stale") {
		console.log(
			`deepswe-bench: re-seeding auth DB from ${decision.source} (staged copy is older than the live store)`,
		);
	} else {
		console.warn(
			`deepswe-bench: staged auth DB ${AUTH_DB} does not open (${decision.fault}); ` +
				`re-seeding from ${decision.source}`,
		);
	}
	snapshotCredentialStore(decision.source, AUTH_DB);
}

/**
 * Prove the STAGED store can serve a token before a single container starts.
 *
 * Seeding it fresh is not the same as it working: a token can be revoked, a
 * subscription exhausted, a refresh rejected. Without this, that was discovered
 * one container at a time, and the resulting message blamed the model id
 * (BACKLOG AUTH-FAILURE-BLAMES-MODEL-ID), which is how a 40-trial run was burned
 * and then misdiagnosed as an unservable model.
 *
 * Probes the same file the containers mount, through
 * `AuthStorage.checkCredentials`, which performs OAuth refresh-on-expiry and
 * then the provider's auth-verifying request per credential without swallowing
 * errors. The verdict logic is `auth-preflight.ts`, under test.
 */
async function requireStagedAuthCanServeToken(model: string, dryRun = false): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(AUTH_DB);
	let probes: CredentialProbe[];
	try {
		const storage = new AuthStorage(store);
		await storage.reload();
		probes = await storage.checkCredentials();
	} finally {
		store.close();
	}

	// Serving a token and having quota left are different questions, and only the
	// first was ever asked. A gateway meters each upstream vendor separately, so a
	// credential authenticates perfectly while the pool this model draws from is at
	// zero. Checking it here costs nothing; discovering it mid-run costs an hour of
	// container setup and leaves a run with missing samples that read as data.
	const spent = exhaustedPoolFor(probes, model);
	if (spent) {
		// A DRY RUN REPORTS THIS RATHER THAN DYING ON IT, and the distinction is the
		// whole point of the flag. `--dry-run` exists to answer "is my arm wired
		// correctly" without paying for a container, and the moment you most want that
		// answer is while waiting for a spent pool to refill so the real run can start
		// the instant it does. Exiting here made the flag unusable in exactly that
		// window: the one time config validation is free, it refused to run.
		//
		// Quota is a property of the model, not of the configuration, so it belongs
		// with the things a dry run cannot check rather than with the guards it exists
		// to apply. It is still printed, because starting a real run against a spent
		// pool is the mistake the check was added to prevent.
		console.error(`deepswe-bench: ${describeExhaustedPool(spent, model)}`);
		if (spentQuotaShouldAbort(spent, dryRun)) process.exit(1);
		console.error("deepswe-bench: continuing anyway because this is a --dry-run; no trial will be started.\n");
	}

	const verdict = decideAuthPreflight(probes);
	if (verdict.kind === "ok") {
		const vendor = modelVendor(model);
		const checked = vendor ? "" : ` Quota pool NOT checked: no vendor could be inferred from "${model}".`;
		console.log(`deepswe-bench: staged auth DB serves a token (${verdict.usable} usable credential(s))${checked}`);
		return;
	}
	if (verdict.kind === "unverifiable") {
		// Loud on purpose. Proceeding is right (some providers have no probe), but
		// a quiet pass here would claim a check that never ran, which is the exact
		// silence this preflight exists to remove.
		console.warn(
			`deepswe-bench: WARNING the staged auth DB could NOT be verified. No probe is configured for: ` +
				`${verdict.providers.join(", ")}. Proceeding UNVERIFIED; an auth failure will now surface per trial.`,
		);
		return;
	}
	console.error(describeAuthPreflightFailure(verdict, AUTH_DB));
	process.exit(1);
}

function sha256File(p: string): string {
	return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Parse a trial's session jsonl(s) into token/tool usage AND whether the argot
 * encode preamble actually reached the model.
 *
 * `preambleTaught` reads the `session_init` entry's `systemPrompt` (a top-level
 * jsonl entry, NOT an `entry.message`) so it reflects the prompt the model was
 * really given, after catalog id resolution. `null` when no `session_init` with a
 * system prompt was seen (presence unknown), `true`/`false` otherwise. This is the
 * authoritative treatment-applied signal (see `systemPromptTeachesArgot`).
 *
 * `argotHandlesLoaded` reads the SDK's `argot_armed` custom_message record (also a
 * top-level entry, `details.handles`), the actually-loaded launch-project handle
 * count. It is what disambiguates a `0 encoded` result: `0` means the corpus had
 * no repeated-token mass (encode impossible, not a model choice); a positive count
 * with `0 encoded` means the model ignored available handles. `null` when no such
 * record was seen (older run or argot off). When several records appear (a resumed
 * session re-arms), the largest wins — a nonzero load is the informative one.
 */
function parseSessionsUsage(trialDir: string): {
	usage: SessionUsage;
	resolvedModel: string | null;
	preambleTaught: boolean | null;
	argotHandlesLoaded: number | null;
	handlesTaughtInPrompt: boolean | null;
	/**
	 * Reasons for every mid-session system-prompt change, in order. Each one is a
	 * full provider prefix-cache invalidation, so the next request re-read the
	 * whole conversation as fresh input at 4x the cached rate. This is what
	 * attributes a `cacheRead: 0` turn to the subsystem that caused it.
	 */
	/**
	 * `null` when the session carried no evidence the instrumentation was live,
	 * which is NOT the same as an empty list. A binary built before
	 * `prompt_cache_invalidated` existed emits nothing, and reporting that as
	 * "zero invalidations, served from cache all session" is a fabricated claim
	 * about the best outcome the system can produce. Only a session that recorded
	 * at least one entry can be trusted to have recorded all of them.
	 */
	promptCacheInvalidations: string[] | null;
	headroom: EncodeHeadroom | null;
} | null {
	const sessionsDir = path.join(trialDir, "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;
	const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
	if (files.length === 0) return null;
	// Read every session line into its message object; the pure tallyUsage does the
	// counting (and the once-per-tool fix) so the same logic is unit-tested. The
	// same pass reads the session_init system prompt for the preamble probe and the
	// argot_armed record for the loaded handle count.
	const messages: Array<Record<string, unknown>> = [];
	let resolvedModel: string | null = null;
	let preambleTaught: boolean | null = null;
	let argotHandlesLoaded: number | null = null;
	let handlesTaughtInPrompt: boolean | null = null;
	const promptCacheInvalidations: string[] = [];
	let vocabEntries: Record<string, string> | null = null;
	for (const file of files) {
		for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as {
					message?: Record<string, unknown>;
					type?: string;
					customType?: string;
					details?: { handles?: unknown; entries?: unknown; inPrompt?: unknown; reason?: unknown };
					systemPrompt?: unknown;
					model?: unknown;
				};
				if (entry.message) messages.push(entry.message);
				if (entry.type === "model_change" && typeof entry.model === "string") {
					resolvedModel =
						resolvedModel === null || resolvedModel === entry.model
							? entry.model
							: `<multiple:${resolvedModel},${entry.model}>`;
				}
				if (entry.type === "session_init" && typeof entry.systemPrompt === "string") {
					// Any session_init that taught the preamble means encode fired; only
					// downgrade to false when a system prompt was seen and none taught it.
					preambleTaught = preambleTaught === true || systemPromptTeachesArgot(entry.systemPrompt);
				}
				if (entry.type === "custom_message" && entry.customType === "argot_taught") {
					// The post-refresh record: whether the handle table actually reached
					// the prompt. This is the ONLY evidence of that, because the arm runs
					// after the `session_init` snapshot. Any single armed refresh that
					// taught the table makes the run taught.
					handlesTaughtInPrompt = handlesTaughtInPrompt === true || entry.details?.inPrompt === true;
				}
				if (entry.type === "custom_message" && entry.customType === "prompt_cache_invalidated") {
					const reason = entry.details?.reason;
					if (typeof reason === "string") promptCacheInvalidations.push(reason);
				}
				if (entry.type === "custom_message" && entry.customType === "argot_armed") {
					const handles = entry.details?.handles;
					if (typeof handles === "number" && Number.isFinite(handles)) {
						// A resumed session can re-arm; the largest load is the informative
						// one (a later empty re-arm must not erase a real earlier vocab).
						argotHandlesLoaded = Math.max(argotHandlesLoaded ?? 0, handles);
					}
					const entries = entry.details?.entries;
					if (entries !== null && typeof entries === "object") {
						// Keep the vocabulary that goes with the largest load, so the
						// headroom is computed against the handles the model actually had.
						const table: Record<string, string> = {};
						for (const [name, expansion] of Object.entries(entries as Record<string, unknown>)) {
							if (typeof expansion === "string") table[name] = expansion;
						}
						if (vocabEntries === null || Object.keys(table).length >= Object.keys(vocabEntries).length) {
							vocabEntries = table;
						}
					}
				}
			} catch {
				// A truncated final line (a killed run) is not a parse we can trust.
			}
		}
	}
	// The ceiling is only computable when the run recorded the vocabulary the model
	// actually had; without it there is nothing to measure the emitted text against.
	const headroom = vocabEntries === null ? null : encodeHeadroom(collectEmittedText(messages), vocabEntries);
	return {
		usage: tallyUsage(messages),
		resolvedModel,
		preambleTaught,
		argotHandlesLoaded,
		handlesTaughtInPrompt,
		headroom,
		promptCacheInvalidations: promptCacheInvalidations.length > 0 ? promptCacheInvalidations : null,
	};
}

/**
 * Read a trial-side log if it exists, else null. Trial directories are written by
 * pier and every file in them is optional: a trial killed during setup has no
 * agent log, one that never raised has no exception file. Absence is normal input
 * here, not an error, so the callers below classify on `null` rather than guarding
 * each read themselves.
 */
function readIfPresent(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}
interface TrialComparisonContext {
	system: ComparisonSystem;
	requestedModel: string;
	execution: ComparisonExecution;
	replayManifest: LoadedReplayManifest | null;
}

function artifactPath(metadataValue: unknown, fallback: string, trialDir: string): string {
	if (typeof metadataValue !== "string" || metadataValue.length === 0) return fallback;
	return path.isAbsolute(metadataValue) ? metadataValue : path.resolve(trialDir, metadataValue);
}

function parsedNativeCompaction(value: unknown): NativeCompactionEvidence | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	return {
		native: raw.native === true,
		artifact: typeof raw.artifact === "string" ? raw.artifact : "",
		beforeTokens: typeof raw.before_tokens === "number" ? raw.before_tokens : null,
		afterTokens: typeof raw.after_tokens === "number" ? raw.after_tokens : null,
	};
}

function parseTrialResult(
	arm: string,
	task: string,
	repeat: number,
	jobDir: string,
	comparison: TrialComparisonContext | null = null,
): ComparisonArmResult {
	const result: ComparisonArmResult = emptyArmResult(arm, task, repeat);
	// Pier truncates long task names in trial dir names, and a job has exactly
	// one trial, so match the single subdirectory.
	const trialDir = fs.readdirSync(jobDir, { withFileTypes: true }).find(d => d.isDirectory());
	if (!trialDir) throw new Error(`no trial dir under ${jobDir}`);
	const trialDirPath = path.join(jobDir, trialDir.name);
	const trial = JSON.parse(fs.readFileSync(path.join(trialDirPath, "result.json"), "utf8"));
	const agent = trial.agent_result ?? {};
	const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
	if (comparison) {
		const patch = path.join(trialDirPath, "artifacts", "model.patch");
		const transcript = path.join(trialDirPath, "agent", "sessions");
		const log = path.join(trialDirPath, "agent", `${comparison.system}.txt`);
		result.system = comparison.system;
		result.requestedModel = comparison.requestedModel;
		result.qualitativeScore = typeof metadata.qualitative_score === "number" ? metadata.qualitative_score : null;
		result.recoveryReads = typeof metadata.recovery_reads === "number" ? metadata.recovery_reads : null;
		result.recoveryTokens = typeof metadata.recovery_tokens === "number" ? metadata.recovery_tokens : null;
		result.providerCostSupported =
			typeof metadata.provider_cost_supported === "boolean" ? metadata.provider_cost_supported : null;
		result.artifacts = {
			patch: artifactPath(metadata.patch_path, patch, trialDirPath),
			transcript: artifactPath(metadata.transcript_path, transcript, trialDirPath),
			log: artifactPath(metadata.log_path, log, trialDirPath),
		};
		result.execution = comparison.execution;
		result.nativeCompaction = parsedNativeCompaction(metadata.native_compaction);
		if (comparison.replayManifest) {
			const manifest = comparison.replayManifest;
			result.replay = {
				manifestSha256: typeof metadata.replay_manifest_sha256 === "string" ? metadata.replay_manifest_sha256 : "",
				sourceSessionId: manifest.manifest.source_session_id,
				sourceSessionArtifacts: manifest.manifest.source_session_artifacts,
				repositoryCheckpoint: manifest.manifest.repository_checkpoint,
				compactionBoundary:
					`${manifest.manifest.compaction_checkpoint.source_boundary_id}` +
					`@user-${manifest.manifest.compaction_checkpoint.after_user_turn}`,
				sourceThresholdTokens: manifest.manifest.compaction_checkpoint.source_threshold_tokens,
				sourceContextTokens: manifest.manifest.compaction_checkpoint.source_context_tokens,
				continuationId: manifest.manifest.held_out_continuation.id,
				continuationArtifact:
					typeof metadata.continuation_artifact === "string" ? metadata.continuation_artifact : "",
			};
			if (result.replay.manifestSha256 !== manifest.sha256) {
				result.error =
					`adapter replay manifest hash ${JSON.stringify(result.replay.manifestSha256)} ` +
					`did not match staged bytes ${manifest.sha256}`;
			}
		} else {
			result.replay = null;
		}
	}
	const rewards = trial.verifier_result?.rewards ?? {};
	result.reward = rewards.reward ?? null;
	result.partial = rewards.partial ?? null;
	result.f2p = rewards.f2p ?? null;
	result.p2p = rewards.p2p ?? null;
	// Usage comes from the session files themselves: pier's agent_result is
	// frozen at run time, and recomputing keeps reaggregated reports correct
	// even when the accounting code changes after a run.
	const parsed = parseSessionsUsage(trialDirPath);
	if (comparison)
		result.resolvedModel =
			parsed?.resolvedModel ?? (typeof metadata.resolved_model === "string" ? metadata.resolved_model : null);
	if (parsed) {
		const { usage } = parsed;
		result.inputTokens = usage.inputTokens ?? null;
		result.outputTokens = usage.outputTokens ?? null;
		result.cacheTokens = usage.cacheTokens ?? null;
		result.cacheReadTokens = usage.cacheReadTokens ?? null;
		result.cacheWriteTokens = usage.cacheWriteTokens ?? null;
		result.costUsd = usage.costUsd ?? null;
		result.argotLoadCalls = usage.argotLoadCalls ?? null;
		result.assistantMsgsWithSigil = usage.assistantMsgsWithSigil ?? null;
		result.argotPreamblePresent = parsed.preambleTaught;
		result.argotHandlesLoaded = parsed.argotHandlesLoaded;
		result.argotHandlesTaught = parsed.handlesTaughtInPrompt;
		result.promptCacheInvalidations = parsed.promptCacheInvalidations;
		result.encodeHeadroom = parsed.headroom;
		result.toolCalls = usage.toolCalls ?? null;
		if (comparison && result.providerCostSupported === null) {
			result.providerCostSupported = (usage.costUsd ?? 0) > 0;
		}
	} else {
		result.inputTokens = agent.n_input_tokens ?? null;
		result.outputTokens = agent.n_output_tokens ?? null;
		result.cacheTokens = agent.n_cache_tokens ?? null;
		result.costUsd = agent.cost_usd ?? null;
		result.argotLoadCalls = agent.metadata?.argot_load_calls ?? null;
		result.assistantMsgsWithSigil = agent.metadata?.assistant_msgs_with_sigil ?? null;
		result.toolCalls = agent.metadata?.tool_calls ?? null;
		if (comparison) {
			result.resolvedModel = typeof metadata.resolved_model === "string" ? metadata.resolved_model : null;
		}
	}
	if (comparison && result.providerCostSupported === false) result.costUsd = null;
	if (comparison) {
		const missingArtifacts = Object.entries(result.artifacts ?? {})
			.filter(([, artifact]) => typeof artifact !== "string" || !fs.existsSync(artifact))
			.map(([name]) => name);
		if (missingArtifacts.length > 0) {
			const message = `missing comparison artifact(s): ${missingArtifacts.join(", ")}`;
			result.error = result.error ? `${result.error}; ${message}` : message;
		}
	}
	if (trial.agent_execution?.started_at && trial.agent_execution?.finished_at) {
		result.agentSeconds =
			(Date.parse(trial.agent_execution.finished_at) - Date.parse(trial.agent_execution.started_at)) / 1000;
	}
	// A trial that finished under its own power and wrote no patch has FAILED THE
	// TASK, and is scored 0 rather than excluded. Pier cannot express that: the
	// missing artifact surfaces as a teardown `RuntimeError` that cancels the trial
	// into n_errored_trials, where it is dropped from every rate and mean. Since
	// every context-shrinking lever here risks exactly that failure mode, letting it
	// delete itself from the measurement would credit the arm that caused it.
	// finishedWithoutPatch reads the full traceback so a KILLED trial (SIGTERM,
	// cancellation, timeout above the same cp failure) keeps its exclusion.
	//
	// The source is the JOB log, not the trial's own exception.txt. Only the job
	// log carries both halves of the discriminator: exception.txt for the one real
	// instance in hand records the cancellation and stops there, with no trace of
	// the artifact download that failed afterwards during teardown.
	const jobLog = readIfPresent(path.join(jobDir, "job.log"));
	if (trial.exception_info && finishedWithoutPatch(jobLog)) {
		// Derived, not invented: no patch means none of the fail-to-pass tests can
		// pass, so f2p and the continuous partial metric are 0 and reward is 0 with
		// them. p2p stays null because the verifier never ran, and claiming the
		// pre-existing tests broke would be a different lie from the one being fixed.
		result.reward = 0;
		result.partial = 0;
		result.f2p = 0;
		return result;
	}
	if (trial.exception_info) {
		let err = JSON.stringify(trial.exception_info).slice(0, 300);
		// pier's exception_info carries the failed command, not WHY the model
		// stopped. A provider content-filter stop (finish reason PROHIBITED_CONTENT /
		// SAFETY / RECITATION) is written to the agent's own log, so read its tail and
		// fold the finish reason into the error. This lets classifyError separate a
		// provider refusal from a genuine crash — an asymmetry that would otherwise be
		// invisible and could silently bias an arm comparison.
		const agentLog = readIfPresent(path.join(trialDirPath, "agent", "veyyon.txt"));
		if (agentLog) {
			const tail = agentLog.slice(-2000);
			const finish = providerFinishReason(tail);
			if (finish) err += ` finish_reason: ${finish}`;
			// A provider quota stop is a global condition with a named recovery time, and
			// it must survive into results.json in a form the report and the run loop can
			// both read back. The raw payload is kilobytes of JSON that the error field
			// truncates away, so restate the two facts that matter compactly.
			const quota = providerQuotaStop(tail);
			if (quota) err += ` ${quotaStopMarker(quota)}`;
		}
		result.error = result.error ? `${result.error}; ${err}` : err;
	}
	// Fail closed on an unscored trial: if the agent ran without an exception but the
	// verifier produced no numeric reward, the trial was NOT scored — do not let the
	// null fold into the pass-rate denominator as a fail. Reclassify it as an error so
	// it is excluded from every rate/mean and surfaced in the Errors (per arm) section,
	// where a verifier outage that tracks one arm becomes a visible confound instead of
	// a silent correctness penalty (Law 10). An existing exception takes precedence.
	if (!result.error && noRewardError(result.reward)) {
		result.error = NO_REWARD_ERROR;
	}
	return result;
}

function reaggregate(runDir: string): void {
	const configDir = path.join(runDir, "configs");
	const jobsRoot = path.join(runDir, "jobs");
	let prior: Record<string, any> | null = null;
	try {
		prior = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
	} catch {
		/* first aggregation */
	}
	const priorByCell = new Map<string, ComparisonArmResult>(
		((prior?.results ?? []) as ComparisonArmResult[]).map(result => [
			`${result.arm}\u0000${result.task}\u0000${result.repeat}`,
			result,
		]),
	);
	const results: ComparisonArmResult[] = [];
	for (const file of fs.readdirSync(configDir).filter(f => f.endsWith(".yaml"))) {
		const jobName = file.slice(0, -".yaml".length);
		const { arm, task, repeat } = parseJobName(jobName);
		try {
			const refreshed = parseTrialResult(arm, task, repeat, path.join(jobsRoot, jobName));
			const old = priorByCell.get(`${arm}\u0000${task}\u0000${repeat}`);
			results.push(
				old
					? {
							...refreshed,
							system: old.system,
							requestedModel: old.requestedModel,
							resolvedModel: old.resolvedModel,
							providerCostSupported: old.providerCostSupported,
							qualitativeScore: old.qualitativeScore,
							recoveryReads: old.recoveryReads,
							recoveryTokens: old.recoveryTokens,
							artifacts: old.artifacts,
							execution: old.execution,
							replay: old.replay,
							nativeCompaction: old.nativeCompaction,
						}
					: refreshed,
			);
		} catch (err) {
			results.push({ ...emptyArmResult(arm, task, repeat), error: String(err) });
		}
	}
	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	let model = "unknown";
	// Preserve the subset provenance the original run recorded (which tasks were
	// sampled, out of how many): a reaggregate re-derives `tasks` from the jobs on
	// disk, so without carrying these forward the "this was a limited subset" signal
	// would silently vanish from the re-rendered results.json.
	let limit: number | null = null;
	let totalTasksAvailable: number | null = null;
	// Carry the recorded sampling regime forward too: a reaggregate does not re-stage
	// arm configs, so it cannot re-derive the temperature that was actually run. Losing
	// it would silently drop the regime provenance from the re-rendered results.json.
	let sampling: unknown = null;
	// The arm fingerprints and binary sha likewise cannot be re-derived from the jobs
	// on disk (a reaggregate does not re-stage), so carry them forward or the run
	// stops being self-identifying after a re-render.
	let armFingerprints: unknown = null;
	let binarySha: string | null = null;
	// Carry the task-set provenance forward too, so a re-render reprints the same
	// selection-bias banner instead of silently dropping it (a reaggregate has no task
	// list to re-parse). Absent on older runs → undefined → no banner, as before.
	let taskSet: (TaskSetProvenance & { file: string | null }) | undefined;
	let incomplete = false;
	if (prior) {
		model = prior.model ?? model;
		limit = prior.limit ?? null;
		totalTasksAvailable = prior.totalTasksAvailable ?? null;
		sampling = prior.sampling ?? null;
		armFingerprints = prior.armFingerprints ?? null;
		binarySha = prior.binarySha ?? null;
		taskSet = prior.taskSet ?? undefined;
		// Carry forward whether the run actually finished. A reaggregate rebuilds the
		// trials from the jobs on disk, which says nothing about whether the run was
		// cut short, and quietly clearing the flag would let a quota-truncated run
		// look complete once it had been re-rendered.
		incomplete = prior.incomplete === true;
	}
	const repeats = results.length ? Math.max(...results.map(r => r.repeat)) + 1 : 1;
	const comparisonRun = prior?.comparison?.run ?? prior?.comparison ?? null;
	const comparisonMode = Array.isArray(comparisonRun?.systems);
	const orderedTasks: string[] = Array.isArray(prior?.tasks) ? prior.tasks : tasks;
	let systemComparison: SystemComparison | null = null;
	let comparisonRejection: string | null = null;
	if (comparisonMode) {
		try {
			systemComparison = aggregateSystemComparison(comparisonTrialsFromArmResults(results), orderedTasks, model);
		} catch (error) {
			comparisonRejection = error instanceof Error ? error.message : String(error);
		}
	}
	fs.writeFileSync(
		path.join(runDir, "results.json"),
		JSON.stringify(
			{
				model,
				binarySha,
				comparison: comparisonMode
					? { run: comparisonRun, aggregate: systemComparison, rejected: comparisonRejection }
					: null,
				limit,
				totalTasksAvailable,
				sampling,
				armFingerprints,
				taskSet,
				arms,
				tasks: orderedTasks,
				repeats,
				incomplete,
				results,
			},
			null,
			2,
		),
	);
	if (comparisonRejection) {
		console.error(
			`\n${comparisonRejection}\nRaw results and artifacts were retained; no comparison report was written.`,
		);
		process.exit(1);
	}
	const report = systemComparison
		? renderSystemComparison(systemComparison)
		: renderReport(results, model, new Date().toISOString(), repeats, taskSet);
	fs.writeFileSync(path.join(runDir, "report.md"), report);
	console.log(`reaggregated ${results.length} runs into ${path.join(runDir, "report.md")}`);
	if (systemComparison) {
		if (systemComparison.overall !== "pass") process.exitCode = 1;
	} else {
		// A reaggregate is what you run after a quota truncation, which is exactly the
		// case the prediction check has to be right about: an arm whose trials all died
		// bills nothing and must read as no measurement, never as a total saving.
		reportPredictedVsActual(runDir, [...new Set(results.map(r => r.arm))], results);
	}
}

/**
 * Pool several completed runs into one report, so a reward comparison can reach
 * enough decisive tasks to be worth reading.
 *
 * A paired sign test cannot reach significance below six decisive tasks, and one
 * day of provider quota funds roughly fifteen tasks across two arms. So a powered
 * reward comparison accumulates over several days, and this is what turns those
 * days into one comparison. `mergeRuns` refuses anything that would make the pool
 * dishonest; see its documentation for which cases and why.
 */
function mergeIntoReport(runDirs: string[], outDir: string | null): void {
	if (runDirs.length < 2) {
		console.error(`--merge needs at least two run directories, got ${runDirs.length}.`);
		process.exit(1);
	}
	const runs: RunToMerge[] = [];
	for (const dir of runDirs) {
		const file = path.join(dir, "results.json");
		if (!fs.existsSync(file)) {
			console.error(`missing: ${file}\nRun --reaggregate on that directory first.`);
			process.exit(1);
		}
		const prior = JSON.parse(fs.readFileSync(file, "utf8"));
		runs.push({
			label: path.basename(dir),
			model: prior.model ?? "unknown",
			binarySha: prior.binarySha ?? null,
			armFingerprints: prior.armFingerprints ?? null,
			results: prior.results ?? [],
		});
	}
	let merged: { results: ArmResult[]; model: string };
	try {
		merged = mergeRuns(runs);
	} catch (err) {
		if (err instanceof MergeRefused) {
			console.error(`refusing to merge: ${err.message}`);
			process.exit(1);
		}
		throw err;
	}
	const target = outDir ?? runDirs[runDirs.length - 1]!;
	fs.mkdirSync(target, { recursive: true });
	const arms = [...new Set(merged.results.map(r => r.arm))];
	const tasks = [...new Set(merged.results.map(r => r.task))];
	const repeats = merged.results.length ? Math.max(...merged.results.map(r => r.repeat)) + 1 : 1;
	fs.writeFileSync(
		path.join(target, "merged-results.json"),
		JSON.stringify(
			{
				model: merged.model,
				mergedFrom: runDirs,
				arms,
				tasks,
				repeats,
				results: merged.results,
			},
			null,
			2,
		),
	);
	fs.writeFileSync(
		path.join(target, "merged-report.md"),
		renderReport(merged.results, merged.model, new Date().toISOString(), repeats, undefined),
	);
	console.log(
		`merged ${runDirs.length} runs (${merged.results.length} trials, ${tasks.length} tasks) into ` +
			`${path.join(target, "merged-report.md")}`,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.reaggregate) {
		reaggregate(path.resolve(args.reaggregate));
		return;
	}
	if (args.merge) {
		mergeIntoReport(
			args.merge
				.split(",")
				.map(dir => dir.trim())
				.filter(Boolean)
				.map(dir => path.resolve(dir)),
			args.out ? path.resolve(args.out) : null,
		);
		return;
	}
	const localTasks = path.join(BENCH_DIR, "deep-swe", "tasks");
	const tasksRootArg =
		args["tasks-root"] ?? process.env.DEEPSWE_TASKS_ROOT ?? (fs.existsSync(localTasks) ? localTasks : undefined);
	if (!tasksRootArg) {
		console.error("pass --tasks-root <dir> (or clone https://github.com/datacurve-ai/deep-swe into this package)");
		process.exit(1);
	}
	const tasksRoot = path.resolve(BENCH_DIR, tasksRootArg);
	const comparisonMode = args.systems !== undefined;
	if (comparisonMode && args.arms !== undefined) {
		console.error("error: --systems and --arms are mutually exclusive");
		process.exit(1);
	}
	const armsArg = comparisonMode ? args.systems : (args.arms ?? "baseline,full");
	const arms = (armsArg ?? "")
		.split(",")
		.map(a => a.trim())
		.filter(Boolean);
	if (arms.length === 0) {
		console.error(`error: --${comparisonMode ? "systems" : "arms"} must specify at least one name`);
		process.exit(1);
	}
	if (comparisonMode) {
		const selected = new Set(arms);
		const invalid = arms.filter(arm => !COMPARISON_SYSTEMS.includes(arm as ComparisonSystem));
		const missing = COMPARISON_SYSTEMS.filter(system => !selected.has(system));
		if (invalid.length > 0 || missing.length > 0 || selected.size !== arms.length) {
			console.error(
				`error: --systems must name each comparison arm exactly once: ${COMPARISON_SYSTEMS.join(",")} ` +
					`(invalid: ${invalid.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
			);
			process.exit(1);
		}
	}
	// Name the model you actually want to bench. The default is a model with a
	// KNOWN-GOOD RECENT RUN, which is all it is: it is not a claim that any other
	// id is unservable.
	//
	// This comment used to assert that the `gemini-3.6-flash` family is
	// live-discovery-gated and resolves to nothing in the offline container. That
	// was FALSE, and it is recorded here rather than deleted because it read as
	// settled knowledge and so kept being propagated into the README and the evals
	// SKILL instead of being questioned. Two runs on the SAME id refute it:
	// `argot-refusal-probe` was 15/15 OK while `argot-budget16k-3.6` was 40/40
	// failures. A model id cannot be both, so the variable was never the id.
	//
	// What a `Model "<id>" not found` at out=0tok almost always means is an AUTH
	// failure wearing the model id's name. Look for a registry-error line, check
	// whether the same id has a passing run, and re-seed the auth DB BEFORE you
	// touch the id or an arm's allowlist. `requireStagedAuthCanServeToken` below
	// exists precisely so that failure is caught at preflight rather than
	// rediscovered forty containers into a multi-hour run.
	//
	// Requested == resolved matters independently: the 3.6→3.5 alias was removed,
	// so the encode gate, which matches the RESOLVED id against an arm's
	// allowlist, fires for the encode arms rather than silently degrading.
	const model = args.model ?? (comparisonMode ? COMPARISON_MODEL : DEFAULT_MODEL);
	if (comparisonMode && model !== COMPARISON_MODEL) {
		console.error(`error: cross-system comparisons require exact model ${COMPARISON_MODEL}, got ${model}`);
		process.exit(1);
	}
	const rawRepeats = Number(args.repeats ?? "1");
	if (!Number.isFinite(rawRepeats) || rawRepeats < 1 || !Number.isInteger(rawRepeats)) {
		console.error(`error: --repeats must be a positive integer (got ${JSON.stringify(args.repeats)})`);
		process.exit(1);
	}
	const repeats = rawRepeats;
	const rawJobs = Number(args.jobs ?? "2");
	const jobParallel = Number.isFinite(rawJobs) && rawJobs > 0 ? Math.floor(rawJobs) : 2;
	// No flat default. A trial's timeout comes from the task's own task.toml
	// budget unless the operator overrides it; see trial-timeout.ts for why a
	// flat number is a validity threat rather than a scheduling preference.
	let trialTimeoutOverrideSec: number | undefined;
	try {
		trialTimeoutOverrideSec = parseTrialTimeoutFlag(args["trial-timeout"]);
	} catch (err) {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	let limit: number | undefined;
	if (args.limit !== undefined) {
		const parsedLimit = Number(args.limit);
		if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
			console.error(`error: --limit must be a positive integer (got ${JSON.stringify(args.limit)})`);
			process.exit(1);
		}
		limit = parsedLimit;
	}
	if (comparisonMode && limit !== undefined) {
		console.error(
			`error: cross-system comparisons use all tasks from ${COMPARISON_TASK_LIST}; --limit is not allowed`,
		);
		process.exit(1);
	}
	const outRoot = path.resolve(
		args.out ?? path.join(BENCH_DIR, "runs", new Date().toISOString().replace(/[:.]/g, "-")),
	);
	const comparisonTaskList = path.resolve(BENCH_DIR, COMPARISON_TASK_LIST);
	const taskListFile = args.tasks
		? path.resolve(BENCH_DIR, args.tasks)
		: comparisonMode
			? comparisonTaskList
			: undefined;
	if (comparisonMode && taskListFile !== comparisonTaskList) {
		console.error(`error: initial cross-system comparisons must use ${COMPARISON_TASK_LIST} unchanged`);
		process.exit(1);
	}
	let tasks: string[];
	let taskSetProvenance: TaskSetProvenance;
	if (taskListFile) {
		const content = fs.readFileSync(taskListFile, "utf8");
		if (comparisonMode && createHash("sha256").update(content).digest("hex") !== COMPARISON_TASK_LIST_SHA256) {
			console.error(`error: ${COMPARISON_TASK_LIST} changed; restore the pinned shared task list before comparison`);
			process.exit(1);
		}
		taskSetProvenance = parseTaskListProvenance(content);
		tasks = content
			.split("\n")
			.map(l => l.trim())
			.filter(l => l && !l.startsWith("#"));
	} else {
		tasks = fs
			.readdirSync(tasksRoot)
			.filter(d => fs.existsSync(path.join(tasksRoot, d, "task.toml")))
			.sort();
		// The whole corpus is by definition the unbiased superset, so a directory scan is
		// a headline set even though it carries no header directive to parse.
		taskSetProvenance = { marked: true, biased: false, note: "full task corpus (directory scan)" };
	}
	if (comparisonMode && tasks.length !== 10) {
		console.error(
			`error: ${COMPARISON_TASK_LIST} must contain the unchanged shared 10-task set; found ${tasks.length}`,
		);
		process.exit(1);
	}
	const totalTasksAvailable = tasks.length;
	if (limit !== undefined && limit < totalTasksAvailable) {
		// Even-stride representative subsample, not the alphabetically-first N (which
		// would cluster on the first repo prefix and bias the pass rate). Loud, because
		// a limited run's pass rate is an estimate over a SUBSET, not the full suite,
		// and must never be read as the headline number.
		tasks = selectTasks(tasks, limit);
		console.error(
			`note: --limit ${limit} selects ${tasks.length} of ${totalTasksAvailable} tasks as an even-stride ` +
				`representative sample; the reported pass rate covers this subset, not the full suite ` +
				`(the exact task list is recorded in results.json).`,
		);
	}
	if (tasks.length === 0) {
		console.error("no tasks selected");
		process.exit(1);
	}

	// A PINNED binary is what makes two days of quota poolable. `mergeRuns` refuses
	// runs whose binary sha differs, and this is a shared tree where other sessions
	// edit `packages/coding-agent` between runs, so a rebuild between days makes the
	// pooling impossible exactly when it is needed: a powered reward test needs more
	// decisive tasks than one day's quota buys.
	const pin = resolveBinaryPin(args.binary);
	if (pin.kind === "invalid") {
		console.error(`error: ${pin.reason}`);
		process.exit(1);
	}
	const pinnedBinary = pin.kind === "pinned" ? pin.path : null;
	if (pinnedBinary) {
		requireFile(pinnedBinary, "point --binary at a previous run's assets/vey");
		console.log(
			`binary PINNED to ${pinnedBinary} (sha256 ${sha256File(pinnedBinary).slice(0, 12)}).\n` +
				`  The working tree is NOT rebuilt, so this run measures that binary's code, not today's.\n` +
				`  That is the point: it is what lets this run pool with the one it came from.`,
		);
	} else {
		await ensureBinaryUpToDate();
	}
	ensureAuthDbSeeded();
	await requireStagedAuthCanServeToken(model, args["dry-run"] !== undefined);
	requireFile(pinnedBinary ?? VEY_BINARY, "build it: cd ../coding-agent && bun scripts/build-binary.ts");
	if (comparisonMode) {
		requireFile(path.join(BENCH_DIR, "arms", "baseline.yml"), "the Veyyon comparison arm requires arms/baseline.yml");
	} else {
		for (const arm of arms) {
			requireFile(path.join(BENCH_DIR, "arms", `${arm}.yml`), `create arms/${arm}.yml`);
		}
	}
	// Resolve every task's timeout up front rather than inside runOne, so a task
	// with an unreadable budget fails at preflight instead of forty containers in.
	const trialTimeouts = new Map<string, ResolvedTrialTimeout>();
	for (const task of tasks) {
		const taskToml = path.join(tasksRoot, task, "task.toml");
		requireFile(taskToml, `no such DeepSWE task: ${task}`);
		try {
			const budget = parseTaskTimeBudget(fs.readFileSync(taskToml, "utf8"), task);
			trialTimeouts.set(task, resolveTrialTimeout(budget, trialTimeoutOverrideSec));
		} catch (err) {
			console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
	}
	const replayManifests = new Map<string, LoadedReplayManifest>();
	if (comparisonMode) {
		const replayRootArg = args["replay-root"];
		if (!replayRootArg) {
			console.error(
				"error: --systems requires --replay-root <absolute-dir> with one validated <task>.json real-session manifest per task",
			);
			process.exit(1);
		}
		const replayRoot = path.resolve(replayRootArg);
		for (const task of tasks) {
			const loaded = loadReplayManifest(path.join(replayRoot, `${task}.json`));
			replayManifests.set(task, loaded);
		}
	}
	const truncation = truncationWarning(trialTimeouts);
	if (truncation) console.error(truncation);
	const undeclaredPhases = [...trialTimeouts].filter(([, r]) => r.missingPhases.length > 0);
	if (undeclaredPhases.length > 0) {
		// Summing an undeclared phase as zero under-budgets the trial by exactly
		// the amount nobody wrote down, so say which tasks are affected.
		const [firstTask, firstResolved] = undeclaredPhases[0] as [string, ResolvedTrialTimeout];
		console.error(
			`warning: ${undeclaredPhases.length} task(s) declare no budget for some trial phase ` +
				`(e.g. ${firstTask} omits ${firstResolved.missingPhases.join(", ")}); those phases contribute 0s ` +
				`to the derived trial timeout.`,
		);
	}
	const pier = Bun.which("pier") ?? `${os.homedir()}/.local/bin/pier`;
	if (!fs.existsSync(pier)) {
		console.error("pier not found on PATH or ~/.local/bin — uv tool install datacurve-pier");
		process.exit(1);
	}
	let factoryBinary: string | null = null;
	let factoryBinarySha: string | null = null;
	let factoryAuth: string | null = null;
	let factorySettings: string | null = null;
	let hermesAuth: string | null = null;
	if (comparisonMode) {
		factoryBinary = args["factory-binary"] ? path.resolve(args["factory-binary"]) : (Bun.which("droid") ?? null);
		if (!factoryBinary) {
			console.error("error: Factory CLI binary unavailable; pass --factory-binary or install droid on PATH");
			process.exit(1);
		}
		requireFile(factoryBinary, "Factory comparison cannot fall back to another agent or binary");
		if (!fs.statSync(factoryBinary).isFile()) {
			console.error(`error: Factory CLI path is not a file: ${factoryBinary}`);
			process.exit(1);
		}
		factoryBinarySha = sha256File(factoryBinary);
		factoryAuth = args["factory-auth"] ? path.resolve(args["factory-auth"]) : null;
		if (!factoryAuth) {
			console.error("error: Factory auth unavailable; pass --factory-auth <nonempty API-key file>");
			process.exit(1);
		}
		requireFile(factoryAuth, "Factory comparison requires an explicit credential path");
		if (!fs.statSync(factoryAuth).isFile()) {
			console.error(`error: Factory auth path is not a file: ${factoryAuth}`);
			process.exit(1);
		}
		if (fs.statSync(factoryAuth).size === 0) {
			console.error(`error: Factory auth file is empty: ${factoryAuth}`);
			process.exit(1);
		}
		if (args["factory-settings"]) {
			factorySettings = path.resolve(args["factory-settings"]);
			requireFile(factorySettings, "Factory settings path was supplied but is unavailable");
			if (!fs.statSync(factorySettings).isFile()) {
				console.error(`error: Factory settings path is not a file: ${factorySettings}`);
				process.exit(1);
			}
		}
		hermesAuth = args["hermes-auth"] ? path.resolve(args["hermes-auth"]) : null;
		if (!hermesAuth) {
			console.error("error: Hermes auth unavailable; pass --hermes-auth <nonempty .env file>");
			process.exit(1);
		}
		requireFile(hermesAuth, "Hermes comparison requires an explicit credential path");
		if (!fs.statSync(hermesAuth).isFile()) {
			console.error(`error: Hermes auth path is not a file: ${hermesAuth}`);
			process.exit(1);
		}
		if (fs.statSync(hermesAuth).size === 0) {
			console.error(`error: Hermes auth file is empty: ${hermesAuth}`);
			process.exit(1);
		}
	}

	const binarySha = sha256File(pinnedBinary ?? VEY_BINARY);

	// Stage the assets every task container sees at /opt/veyyon-assets.
	const assetsDir = path.join(outRoot, "assets");
	fs.mkdirSync(path.join(assetsDir, "arms"), { recursive: true });
	fs.copyFileSync(pinnedBinary ?? VEY_BINARY, path.join(assetsDir, "vey"));
	fs.chmodSync(path.join(assetsDir, "vey"), 0o755);
	fs.copyFileSync(AUTH_DB, path.join(assetsDir, "auth-agent.db"));
	if (comparisonMode) {
		fs.copyFileSync(factoryBinary!, path.join(assetsDir, "droid"));
		fs.chmodSync(path.join(assetsDir, "droid"), 0o755);
		fs.copyFileSync(factoryAuth!, path.join(assetsDir, "factory-api-key"));
		fs.chmodSync(path.join(assetsDir, "factory-api-key"), 0o600);
		if (factorySettings) fs.copyFileSync(factorySettings, path.join(assetsDir, "settings.json"));
		fs.copyFileSync(hermesAuth!, path.join(assetsDir, "hermes.env"));
		fs.chmodSync(path.join(assetsDir, "hermes.env"), 0o600);
	}
	// Stage each arm's config overlay, an optional per-section prompt override,
	// and an optional .rule.md, then fingerprint the exact inputs the container
	// will see. A per-section prompt experiment lives in a SEPARATE
	// arms/<arm>.sections.yml file (section -> replacement text), staged as
	// sections/<arm>.json — the exact JSON bytes the agent reads through the
	// eval-only VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS env var. It is deliberately NOT
	// a config key: no config.yml can reach it, so it cannot contaminate a normal
	// run. A per-STATEMENT experiment rides the same way from
	// arms/<arm>.statements.yml, which is the vehicle for ablating or rewording ONE
	// rule; a section override cannot do that, since TOOL POLICY is one region and
	// 34 rules. The fingerprint enforces the single-IV floor below: two arms may not
	// reduce to identical (config, sections, statements, rule).
	// An `--arms` entry naming an ATTACHMENT would otherwise be read as an arm config: `--arms
	// candidate-delivery-terse.sections` finds `candidate-delivery-terse.sections.yml`, parses a
	// section-override map as a config overlay, and benches nonsense with no error. Refused with the
	// arm name the operator meant.
	// Refuse a typo and an attachment name before anything is staged. The predicate lives in
	// `arm-fingerprint.ts` so it is unit-testable: this file ends in a top-level `await main()`, so a
	// test that imported it would run a bench.
	if (!comparisonMode) {
		const available = armNamesIn(fs.readdirSync(path.join(BENCH_DIR, "arms")));
		for (const arm of arms) {
			const problem = armSelectionError(arm, available);
			if (problem !== null) {
				console.error(`error: ${problem}`);
				process.exit(1);
			}
		}
	}
	const armFingerprints = new Map<string, string>();
	const armTemperature = new Map<string, number>();
	// Arms that declare an ENCODE treatment (argot on, non-empty allowlist). After
	// the run, every such arm MUST have actually taught the encode preamble to the
	// model, or it silently degraded to decode-only and measured the wrong condition
	// (the pre-run allowlist guard cannot catch a post-resolution model mismatch).
	const encodeArms = new Set<string>();
	for (const arm of arms) {
		if (comparisonMode && arm !== "veyyon") {
			armTemperature.set(arm, PINNED_TEMPERATURE);
			armFingerprints.set(arm, createHash("sha256").update(`system-adapter:${arm}`).digest("hex"));
			continue;
		}
		const configArm = comparisonMode ? "baseline" : arm;
		const ymlText = fs.readFileSync(path.join(BENCH_DIR, "arms", `${configArm}.yml`), "utf8");
		let config: unknown;
		try {
			config = YAML.parse(ymlText) ?? {};
		} catch (err) {
			console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.yml:\n${err}`);
			process.exit(1);
		}
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml must be a mapping of setting -> value, ` +
					`got ${Array.isArray(config) ? "a sequence" : typeof config}.`,
			);
			process.exit(1);
		}
		// Pin the sampling temperature identically for every arm (unless the arm sets
		// its own for a deliberate temperature-as-IV experiment) so `--repeats`
		// measures a stable regime instead of a drifting provider default, and stamp
		// the effective value into results.json below. Injecting it into the parsed
		// config BEFORE fingerprinting keeps the single-IV floor intact: the same
		// value goes into every arm, so it never becomes a spurious difference, and
		// the staged file the container reads matches exactly what was fingerprinted.
		// An unrecognised key is not an error to veyyon: the overlay merges, the key
		// is never read, and the arm runs as the control under a treatment's name.
		// Refuse, rather than report a comparison of the control against itself.
		const mistyped = mistypedArmSettings(config, path =>
			isSettingPath(path) ? { kind: getType(path), values: getEnumValues(path) } : undefined,
		);
		if (mistyped.length > 0) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml sets ${mistyped.length} key(s) to a value the settings\n` +
					`schema would reject:\n` +
					mistyped.map(m => `  ${m.path}: expected ${m.expected}, got ${m.actual}`).join("\n") +
					`\nAn unusable value is merged and then ignored, so the arm would run as the\n` +
					`control while claiming a treatment. Note that YAML reads bare yes/no/on/off\n` +
					`as booleans and quoted "0.1" as a string.`,
			);
			process.exit(1);
		}
		const unknown = unknownArmSettings(config, isSettingPath);
		if (unknown.length > 0) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml sets ${unknown.length} key(s) that are not veyyon settings:\n` +
					unknown.map(p => `  ${p}`).join("\n") +
					`\nAn unknown key is merged and never read, so the arm would run as the\n` +
					`control while claiming a treatment. Check the spelling against\n` +
					`docs/settings-reference.md, or remove the key.`,
			);
			process.exit(1);
		}
		const temperature = effectiveTemperature(config);
		(config as Record<string, unknown>).temperature = temperature;
		armTemperature.set(arm, temperature);
		if (isEncodeArm(config)) encodeArms.add(arm);
		fs.writeFileSync(path.join(assetsDir, "arms", `${arm}.yml`), YAML.stringify(config));
		// Treatment-applies floor: an encode arm (argot on, non-empty allowlist) only
		// applies its treatment if the model under test is on that allowlist. If it is
		// not, argot silently stops encoding and the arm secretly measures decode-only
		// while still being labelled as the encode condition — a Law-10 silent fallback
		// inside the eval set. Refuse to run it, using argot's OWN matching rule.
		const mismatch = encodeArmModelMismatch(config, model);
		if (mismatch !== null) {
			console.error(
				`error: arm "${arm}" enables argot encoding with an allowlist that does not\n` +
					`include the model under test, so it would SILENTLY degrade to decode-only\n` +
					`and measure the wrong condition:\n` +
					`  arms/${arm}.yml argot.models = [${mismatch.join(", ")}]\n` +
					`  --model = ${model}\n` +
					`Fix: add the model to arms/${arm}.yml argot.models (a bare name like\n` +
					`"${model.slice(model.lastIndexOf("/") + 1)}" matches any provider), or bench a --model the arm\n` +
					`already lists, or use arms/decode.yml if you meant the decode-only condition.`,
			);
			process.exit(1);
		}
		let sections: unknown;
		const sectionsPath = path.join(BENCH_DIR, "arms", `${configArm}.sections.yml`);
		if (fs.existsSync(sectionsPath)) {
			try {
				sections = YAML.parse(fs.readFileSync(sectionsPath, "utf8")) ?? {};
			} catch (err) {
				console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.sections.yml:\n${err}`);
				process.exit(1);
			}
			if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
				console.error(
					`error: arm "${arm}" arms/${arm}.sections.yml must be a mapping of section -> replacement text, ` +
						`got ${Array.isArray(sections) ? "a sequence" : typeof sections}.`,
				);
				process.exit(1);
			}
			fs.mkdirSync(path.join(assetsDir, "sections"), { recursive: true });
			// Stage the exact JSON the env var will carry (compact, deterministic).
			fs.writeFileSync(path.join(assetsDir, "sections", `${arm}.json`), JSON.stringify(sections));
		}
		// A per-STATEMENT override, the finer vehicle: `statement id -> replacement text, or null to
		// ablate the rule`. A section override is the wrong instrument for an ablation, since TOOL POLICY
		// is 34 rules in one region and a score change across it cannot be attributed to a cause.
		let statements: unknown;
		const statementsPath = path.join(BENCH_DIR, "arms", `${configArm}.statements.yml`);
		if (fs.existsSync(statementsPath)) {
			try {
				statements = YAML.parse(fs.readFileSync(statementsPath, "utf8")) ?? {};
			} catch (err) {
				console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.statements.yml:\n${err}`);
				process.exit(1);
			}
			if (statements === null || typeof statements !== "object" || Array.isArray(statements)) {
				console.error(
					`error: arm "${arm}" arms/${arm}.statements.yml must be a mapping of statement id -> ` +
						`replacement text (or null to ablate the statement), got ` +
						`${Array.isArray(statements) ? "a sequence" : typeof statements}.`,
				);
				process.exit(1);
			}
			// Values are checked here as well as in the agent, because a bad value is cheap to catch now
			// and expensive to discover after paying for a run: the prompt builder refuses the payload,
			// so every trial in the arm would hard-error identically.
			for (const [id, value] of Object.entries(statements as Record<string, unknown>)) {
				if (value !== null && typeof value !== "string") {
					console.error(
						`error: arm "${arm}" arms/${arm}.statements.yml value for "${id}" must be text, or null to ` +
							`ablate the statement, got ${typeof value}.`,
					);
					process.exit(1);
				}
			}
			fs.mkdirSync(path.join(assetsDir, "statements"), { recursive: true });
			// The exact JSON the env var will carry. `null` survives JSON, which is what makes ablation
			// expressible: an empty string would mean "this rule says nothing but is still here".
			fs.writeFileSync(path.join(assetsDir, "statements", `${arm}.json`), JSON.stringify(statements));
		}
		let rule: Uint8Array | undefined;
		const rulePath = path.join(BENCH_DIR, "arms", `${configArm}.rule.md`);
		if (fs.existsSync(rulePath)) {
			rule = fs.readFileSync(rulePath);
			fs.mkdirSync(path.join(assetsDir, "rules"), { recursive: true });
			fs.writeFileSync(path.join(assetsDir, "rules", `${arm}.md`), rule);
		}
		const mod: ArmInputs = {
			config,
			...(sections !== undefined ? { sections } : {}),
			...(statements !== undefined ? { statements } : {}),
			...(rule !== undefined ? { rule } : {}),
		};
		armFingerprints.set(arm, computeArmFingerprint(mod));
	}
	// Single-IV floor: a controlled comparison must vary exactly one independent
	// variable (README, "Single Independent Variable Rule"). Byte-identical arms
	// vary ZERO, so every delta between them is noise — the silent no-op arm
	// (candidate-vN copied from baseline with nothing changed). Fail loudly with
	// the exact collision rather than emit a result-shaped table with no cause.
	if (arms.length >= 2) {
		const collisions = findZeroIvCollisions(armFingerprints);
		if (collisions.length > 0) {
			const detail = collisions.map(group => `  {${group.join(", ")}} reduce to identical inputs`).join("\n");
			console.error(
				"error: zero-IV arm collision — a controlled comparison must vary exactly one\n" +
					"independent variable, but these arms reduce to the same (config, sections, statements,\n" +
					`rule), so every delta between them is noise:\n${detail}\n` +
					"Fix: give each arm a distinct config, a distinct .sections.yml, a distinct\n" +
					".statements.yml, or a distinct .rule.md, or drop the redundant arm from --arms. See\n" +
					"README 'Single Independent Variable Rule'.",
			);
			process.exit(1);
		}
	}

	const comparisonExecutionByTask = new Map<string, ComparisonExecution>();
	if (comparisonMode) {
		for (const task of tasks) {
			const timeout = trialTimeouts.get(task);
			const replay = replayManifests.get(task);
			if (!timeout || !replay) throw new Error(`internal: incomplete comparison provenance for ${task}`);
			const instructionPath = path.join(tasksRoot, task, "instruction.md");
			requireFile(instructionPath, `task ${task} has no instruction.md`);
			comparisonExecutionByTask.set(task, {
				taskInstructionsHash: sha256File(instructionPath),
				repositoryStateHash: replay.manifest.repository_checkpoint_sha256,
				wallClockLimitSeconds: timeout.timeoutSec,
				temperature: PINNED_TEMPERATURE,
				samplingDescription:
					"temperature 0 where the native API exposes sampling; otherwise native fixed/default sampling",
			});
		}
	}
	const results: ComparisonArmResult[] = [];
	const queue = trialQueue(arms, tasks, repeats);
	// Fail-fast canary state (see runOne). The canary window is the first wave of
	// completed jobs — the smaller of the worker-pool width and the total queue —
	// so a systematic config failure trips as soon as one full concurrent batch has
	// all hard-errored, not after the whole queue drains.
	const totalQueued = queue.length;
	const canarySize = Math.max(1, Math.min(Math.max(1, jobParallel), totalQueued));
	let canaryTripped = false;

	console.log(
		`deepswe-bench: ${arms.length} arm(s) x ${tasks.length} task(s)` +
			`${repeats > 1 ? ` x ${repeats} repeat(s)` : ""} = ${queue.length} run(s), model ${model}`,
	);
	console.log(`assets: ${assetsDir} (binary sha256 ${binarySha.slice(0, 12)}) → jobs under ${outRoot}`);
	const overrides = arms.filter(a => (armTemperature.get(a) ?? PINNED_TEMPERATURE) !== PINNED_TEMPERATURE);
	console.log(
		`sampling: temperature pinned to ${PINNED_TEMPERATURE} (greedy) for every arm, stamped into results.json` +
			(overrides.length > 0
				? `; arm(s) with an explicit override: ${overrides.map(a => `${a}=${armTemperature.get(a)}`).join(", ")}`
				: ""),
	);

	// `--dry-run`: validate everything, run nothing.
	//
	// WHY THIS EXISTS. Every guard in this file is a PRE-run guard, but reaching
	// them still costs an auth preflight and asset staging, and any mistake past
	// them costs a container. A single DeepSWE task can run for 90 minutes, so the
	// feedback loop for "is my arm wired correctly" was measured in hours, and the
	// answer was usually a one-line typo in a YAML file.
	//
	// Everything above has already happened by this point: arm YAML parsed and
	// validated, sections parsed and staged, temperature pinned, fingerprints
	// computed and checked for a zero-IV collision, encode-arm allowlists matched
	// against the model, task files and the agent binary confirmed present, and the
	// auth preflight actually served a token. So a dry run answers every question
	// that does not require the model itself, in seconds.
	//
	// It prints the queue and the resolved per-arm inputs so the plan can be read
	// before it is paid for, then exits 0. It writes no report, because a run that
	// executed nothing has nothing to report and an empty report is worse than
	// none: it would sit in `runs/` looking like a result.
	if (args["dry-run"] !== undefined) {
		console.log("\nDRY RUN — every pre-run guard passed. No container was started and no report written.\n");
		console.log(`  model      ${model}`);
		// Surface the provenance here too: it decides whether the number this run
		// would produce is reportable as a headline, and that is worth knowing
		// BEFORE paying for the run rather than from the report banner after.
		const provenance = taskSetProvenance.marked
			? taskSetProvenance.biased
				? `@biased (never a headline)${taskSetProvenance.note ? ` — ${taskSetProvenance.note}` : ""}`
				: "@headline"
			: "UNMARKED (no @headline/@biased directive)";
		console.log(`  tasks      ${tasks.length} from ${args.tasks ?? "(full corpus)"}  ${provenance}`);
		console.log(`  arms       ${arms.length}`);
		for (const arm of arms) {
			const sectionsFile = path.join(BENCH_DIR, "arms", `${arm}.sections.yml`);
			const statementsFile = path.join(BENCH_DIR, "arms", `${arm}.statements.yml`);
			const ruleFile = path.join(BENCH_DIR, "arms", `${arm}.rule.md`);
			const parts = [
				`temp=${armTemperature.get(arm)}`,
				encodeArms.has(arm) ? "ENCODE" : "no-encode",
				fs.existsSync(sectionsFile) ? "sections" : null,
				fs.existsSync(statementsFile) ? "statements" : null,
				fs.existsSync(ruleFile) ? "rule" : null,
			].filter(Boolean);
			console.log(`    ${arm.padEnd(28)} ${parts.join(" ")}  fp=${(armFingerprints.get(arm) ?? "").slice(0, 12)}`);
		}
		console.log(
			`  queue      ${queue.length} run(s) = ${arms.length} arm(s) x ${tasks.length} task(s) x ${repeats} repeat(s)`,
		);
		// The staged assets are left in place deliberately rather than cleaned up:
		// they are the exact bytes each container would mount, so a dry run is also
		// the way to READ what an arm resolves to (config after temperature
		// injection, the sections JSON, the rule) before paying to run it. Said out
		// loud so the leftover directory is understood as output, not residue.
		console.log(`  staged     ${assetsDir}`);
		console.log("             (the exact bytes a container would mount; inspect them, then delete the dir)");
		console.log(`  would cost ${queue.length} trial(s) of real model quota\n`);
		console.log("Re-run without --dry-run to execute.");
		process.exit(0);
	}

	// Stamp the run's provenance BEFORE any trial runs, so a run that dies partway
	// still says what it was.
	//
	// WHY THIS IS NOT MERELY TIDY. `results.json` used to be written only at the very
	// end, so a run cut short by provider quota never wrote one at all, and its model,
	// binary sha and arm fingerprints were lost permanently. `--reaggregate` can
	// rebuild the per-trial results from the jobs on disk, but it can only carry the
	// provenance forward from a PRIOR `results.json`; with none, it fills in
	// `model: "unknown"` and `binarySha: null` and the run can never be pooled with
	// another, because `--merge` cannot confirm it used the same model or binary.
	//
	// That is exactly the run this bench produces most often. Quota truncation is
	// normal here, and with task-major ordering a truncated run now yields perfectly
	// good paired samples. Losing them to a missing header would waste the very
	// samples the ordering change exists to save.
	//
	// The trial list is empty at this point and is overwritten by the real one when
	// the run completes. Everything else is already known and never changes.
	const provenance = {
		model,
		binarySha,
		comparison: comparisonMode
			? {
					systems: COMPARISON_SYSTEMS,
					taskList: COMPARISON_TASK_LIST,
					replayManifests: Object.fromEntries(
						tasks.map(task => [task, replayManifests.get(task)?.sha256 ?? null]),
					),
					factoryBinarySha,
				}
			: null,
		limit: limit ?? null,
		totalTasksAvailable,
		sampling: {
			pinnedTemperature: PINNED_TEMPERATURE,
			perArm: Object.fromEntries(arms.map(a => [a, armTemperature.get(a) ?? PINNED_TEMPERATURE])),
			note: "greedy at temperature 0: top-p / top-k are irrelevant, so temperature alone fixes the regime",
		},
		armFingerprints: Object.fromEntries(arms.map(a => [a, armFingerprints.get(a) ?? null])),
		taskSet: { file: args.tasks ?? (comparisonMode ? COMPARISON_TASK_LIST : null), ...taskSetProvenance },
		arms,
		tasks,
		repeats,
		// Marks a header written before the trials ran. A file still carrying this
		// flag is a run that never finished, which is a fact worth keeping rather
		// than one to infer from an empty results array.
		incomplete: true,
		results: [],
	};
	fs.writeFileSync(path.join(outRoot, "results.json"), JSON.stringify(provenance, null, 2));

	function writeJobConfig(arm: string, task: string, repeat: number): string {
		const jobName = jobNameOf(arm, task, repeat, repeats);
		const configDir = path.join(outRoot, "configs");
		fs.mkdirSync(configDir, { recursive: true });
		const configPath = path.join(configDir, `${jobName}.yaml`);
		const common = [
			`job_name: ${JSON.stringify(jobName)}`,
			`jobs_dir: ${JSON.stringify(path.join(outRoot, "jobs"))}`,
			"quiet: true",
			"n_concurrent_trials: 1",
			"tasks:",
			`  - path: ${JSON.stringify(path.join(tasksRoot, task))}`,
			"agents:",
		];
		let agent: string[];
		if (!comparisonMode || arm === "veyyon") {
			agent = [
				"  - import_path: veyyon_agent:VeyyonAgent",
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      arm_name: ${JSON.stringify(arm)}`,
				`      assets_dir: ${JSON.stringify(assetsDir)}`,
				`      binary_sha: ${JSON.stringify(binarySha)}`,
				`      prompt_template_path: ${JSON.stringify(path.join(BENCH_DIR, "pier_agent", "oneshot_prompt.md.j2"))}`,
				...(comparisonMode ? [`      replay_path: ${JSON.stringify(replayManifests.get(task)?.path)}`] : []),
			];
		} else if (arm === "factory") {
			agent = [
				"  - import_path: factory_agent:FactoryAgent",
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      assets_dir: ${JSON.stringify(assetsDir)}`,
				`      binary_sha: ${JSON.stringify(factoryBinarySha)}`,
				`      replay_path: ${JSON.stringify(replayManifests.get(task)?.path)}`,
			];
		} else {
			agent = [
				"  - import_path: hermes_agent:HermesAgent",
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      replay_path: ${JSON.stringify(replayManifests.get(task)?.path)}`,
				`      auth_path: ${JSON.stringify(path.join(assetsDir, "hermes.env"))}`,
			];
		}
		const yaml = [...common, ...agent, ""].join("\n");
		fs.writeFileSync(configPath, yaml);
		return configPath;
	}

	async function runOne(arm: string, task: string, repeat: number, attempt = 1): Promise<void> {
		const jobName = jobNameOf(arm, task, repeat, repeats);
		const jobDir = path.join(outRoot, "jobs", jobName);
		if (attempt > 1 && fs.existsSync(jobDir)) {
			fs.rmSync(jobDir, { recursive: true, force: true });
			try {
				await Bun.spawn(["sh", "-c", `docker rm -f $(docker ps -aq --filter name=${jobName}) 2>/dev/null || true`])
					.exited;
				await Bun.spawn(["docker", "network", "prune", "-f"]).exited;
			} catch {
				/* best effort */
			}
		}
		const started = Date.now();
		const proc = Bun.spawn([pier, "run", "-c", writeJobConfig(arm, task, repeat), "-q"], {
			cwd: path.join(BENCH_DIR, "pier_agent"),
			env: { ...process.env, PYTHONPATH: path.join(BENCH_DIR, "pier_agent") },
			stdout: "pipe",
			stderr: "pipe",
		});
		// Preflight populated this for every selected task, so a miss here is a
		// programming error rather than a runtime condition to paper over.
		const resolvedTimeout = trialTimeouts.get(task);
		if (!resolvedTimeout) throw new Error(`internal: no resolved trial timeout for task ${task}`);
		const trialTimeoutSec = resolvedTimeout.timeoutSec;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, trialTimeoutSec * 1000);

		const exitCode = await proc.exited;
		clearTimeout(timer);
		const stdout = await readPipeText(proc.stdout);
		const stderr = await readPipeText(proc.stderr);

		let result: ComparisonArmResult;
		try {
			if (timedOut) throw new Error(`trial timed out after ${trialTimeoutSec}s`);
			const comparisonContext: TrialComparisonContext | null = comparisonMode
				? {
						system: arm as ComparisonSystem,
						requestedModel: model,
						execution: comparisonExecutionByTask.get(task)!,
						replayManifest: replayManifests.get(task) ?? null,
					}
				: null;
			result = parseTrialResult(arm, task, repeat, jobDir, comparisonContext);
		} catch (err) {
			const errStr = `${err}; pier exit ${exitCode}; ${stderr.slice(-300) || stdout.slice(-300)}`;
			if (
				attempt === 1 &&
				!timedOut &&
				(errStr.includes("Docker compose command failed") ||
					errStr.includes("FileExistsError") ||
					errStr.includes("ENOENT"))
			) {
				console.log(
					`[retry] ${jobName} hit container startup collision; pruning docker network & retrying (attempt 2)...`,
				);
				return await runOne(arm, task, repeat, 2);
			}
			result = { ...emptyArmResult(arm, task, repeat), error: errStr };
		}
		if (comparisonMode) result.agentSeconds = (Date.now() - started) / 1000;
		results.push(result);
		const mark = result.error ? "ERROR" : result.reward === 1 ? "pass" : `reward=${result.reward}`;
		// Denominator is the STABLE total (`totalQueued`), not `queue.length`: the
		// worker pool shifts items off `queue` as it drains, so `queue.length` is the
		// REMAINING count and `[done/remaining]` reads as a shrinking, confusing ratio.
		// `[done/total]` is the honest progress fraction.
		console.log(
			`[${results.length}/${totalQueued}] ${jobName}: ${mark} out=${result.outputTokens ?? "?"}tok cost=$${result.costUsd?.toFixed(3) ?? "?"} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
		);
		// Quota abort. This runs BEFORE both canaries because it is the only stop
		// condition that is self-declaring: the provider states a global refusal and
		// names its own recovery time, so one occurrence is proof and waiting for a
		// statistical wave is pure waste. Neither canary would catch it anyway —
		// quota strikes mid-run, so an early success has already disarmed the global
		// one, and it kills every arm at once so the per-arm one sees no dead arm.
		// Without this the run keeps burning container setup on trials that cannot
		// produce a token, and then reports a comparison against an arm whose samples
		// simply are not there.
		const quotaStop = !canaryTripped ? providerQuotaStop(result.error) : null;
		if (quotaStop) {
			canaryTripped = true;
			const until = quotaStop.resetAt ? ` Quota resets at ${quotaStop.resetAt}.` : "";
			const which = quotaStop.model ? ` for model "${quotaStop.model}"` : "";
			console.error(
				`\nABORTING: the provider refused on quota${which} (HTTP 429 RESOURCE_EXHAUSTED).${until} ` +
					`Every one of the ${queue.length} remaining trials would fail the same way and produce no ` +
					`tokens, leaving a comparison against arms with missing samples. ${results.length} trials ` +
					`completed before the stop; their jobs are on disk and can be reaggregated. Rerun after the ` +
					`reset, or point --model at a credential with quota left. No report was written.`,
			);
		}
		// Fail-fast canary: a config that makes EVERY run error (an unservable model,
		// a bad auth DB, a missing binary) otherwise burns the whole run — 120 jobs ×
		// ~1min of container setup — to prove one typo. The trip DECISION is the pure,
		// tested `shouldTripCanary` (a full wave of hard errors); the reason string is
		// the mode of those errors, so the operator sees `Model "..." not found` in
		// seconds instead of after an hour of red.
		if (!canaryTripped && shouldTripCanary(results, canarySize)) {
			canaryTripped = true;
			const hardErrors = results.filter(isHardError).map(r => r.error ?? "");
			console.error(
				`\nABORTING: the first ${results.length} trials ALL failed before the agent produced any output ` +
					`(0 successful runs). This is a systematic config failure, not task flakiness — the remaining ` +
					`${queue.length} queued trials would fail identically. Most common agent-side reason:\n\n` +
					`  ${mostCommonAgentReason(hardErrors)}\n\n` +
					`Fix the config (model id must be servable in the sandbox; see run.ts) and rerun. No report was written.`,
			);
		}
		// The per-arm half. The global predicate above is disarmed permanently by a
		// single success anywhere, so a 100%-dead arm running beside a healthy one
		// never trips it: the run burns the whole queue and then reports a comparison
		// against an arm that produced nothing. That is the argot failure already seen
		// once. Aborting here names the dead arm, because "some arm is broken" sends
		// the operator looking at the wrong config.
		if (!canaryTripped) {
			const deadArm = armCanaryFailure(results, canarySize);
			if (deadArm !== undefined) {
				canaryTripped = true;
				const armErrors = results.filter(r => r.arm === deadArm && isHardError(r)).map(r => r.error ?? "");
				console.error(
					`\nABORTING: every one of the ${armErrors.length} completed trials for arm "${deadArm}" failed before ` +
						`the agent produced any output. Other arms are running, so this is not a global config failure — ` +
						`it is "${deadArm}" specifically, and the remaining ${queue.length} queued trials would leave you ` +
						`with a comparison against an arm that produced nothing. Most common agent-side reason:\n\n` +
						`  ${mostCommonAgentReason(armErrors)}\n\n` +
						`Fix that arm's config and rerun. No report was written.`,
				);
			}
		}
	}

	// Small bounded pool: task containers take 2 cpu / 8 GB each.
	const workers = Array.from({ length: Math.max(1, jobParallel) }, async () => {
		for (;;) {
			if (canaryTripped) return;
			const next = queue.shift();
			if (!next) return;
			await runOne(next.arm, next.task, next.repeat);
		}
	});
	await Promise.all(workers);

	// If the fail-fast canary tripped, every completed trial was a hard error: no
	// arm produced usable output, so any report would be a page of red with no
	// measurable metric. Exit non-zero WITHOUT writing results.json/report.md, so a
	// CI gate or a watching operator treats it as the config failure it is rather
	// than a "run finished" that silently contains nothing (Law 10: fail closed, no
	// silent degrade). The abort reason was already printed by runOne.
	if (canaryTripped) {
		process.exit(1);
	}

	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	let systemComparison: SystemComparison | null = null;
	let comparisonRejection: string | null = null;
	if (comparisonMode) {
		try {
			systemComparison = aggregateSystemComparison(comparisonTrialsFromArmResults(results), tasks, model);
		} catch (error) {
			comparisonRejection = error instanceof Error ? error.message : String(error);
		}
	}
	fs.writeFileSync(
		path.join(outRoot, "results.json"),
		JSON.stringify(
			{
				model,
				binarySha,
				comparison: comparisonMode
					? {
							run: provenance.comparison,
							aggregate: systemComparison,
							rejected: comparisonRejection,
						}
					: null,
				limit: limit ?? null,
				totalTasksAvailable,
				sampling: {
					pinnedTemperature: PINNED_TEMPERATURE,
					perArm: Object.fromEntries(arms.map(a => [a, armTemperature.get(a) ?? PINNED_TEMPERATURE])),
					note: "greedy at temperature 0: top-p / top-k are irrelevant, so temperature alone fixes the regime",
				},
				// The semantic fingerprint of each arm's exact (config, sections, rule)
				// inputs — the same value the zero-IV guard uses. Stamping it makes every
				// run self-identifying: two runs of an arm with the same name but a changed
				// config produce different fingerprints, so a longitudinal diff catches the
				// drift instead of silently comparing two different treatments.
				armFingerprints: Object.fromEntries(arms.map(a => [a, armFingerprints.get(a) ?? null])),
				// Whether the task set is safe to headline or a selection-biased best case,
				// stamped so a reaggregate reprints the same provenance banner and a biased
				// run can never be silently promoted to a headline number later.
				taskSet: { file: args.tasks ?? (comparisonMode ? COMPARISON_TASK_LIST : null), ...taskSetProvenance },
				arms,
				tasks,
				repeats,
				// The run reached the end, so clear the flag the pre-run header set.
				// A `results.json` still carrying `incomplete: true` is a run that died.
				incomplete: false,
				results,
			},
			null,
			2,
		),
	);
	if (comparisonRejection) {
		console.error(
			`\n${comparisonRejection}\nRaw results and artifacts were retained; no comparison report was written.`,
		);
		process.exit(1);
	}
	const report = systemComparison
		? renderSystemComparison(systemComparison)
		: renderReport(results, model, new Date().toISOString(), repeats, taskSetProvenance);
	fs.writeFileSync(path.join(outRoot, "report.md"), report);
	console.log(`\nwrote ${path.join(outRoot, "report.md")} and results.json`);

	if (systemComparison) {
		if (systemComparison.overall !== "pass") process.exitCode = 1;
	} else {
		reportPredictedVsActual(outRoot, arms, results);
	}

	// Authoritative post-run treatment check. The pre-run allowlist guard matched the
	// REQUESTED --model, but the runtime resolves that id through the catalog (provider
	// aliases, effort-tier collapsing) to a different logical id before argot's encode
	// gate runs. So an encode arm can pass the pre-run guard yet run decode-only if the
	// RESOLVED model fell off the allowlist. Read whether the preamble actually reached
	// the model (from the session system prompt) and FAIL CLOSED if an encode arm never
	// taught it: a silent decode-only degrade makes every token delta against that arm
	// measure nothing, so the run is invalid and must not be reported as sound.
	const degraded: string[] = [];
	for (const arm of encodeArms) {
		const flags = results.filter(r => r.arm === arm && !r.error).map(r => r.argotPreamblePresent);
		if (encodePreambleSilentlyDropped(flags)) degraded.push(arm);
	}
	if (degraded.length > 0) {
		console.error(
			`\nerror: encode arm(s) [${degraded.join(", ")}] never taught the argot preamble in ANY\n` +
				`OK trial, so they SILENTLY ran decode-only and every token delta against them is inert.\n` +
				`The likely cause is a model-id resolution mismatch: the requested --model = ${model}\n` +
				`resolves through the catalog to a different logical id that is not on the arm's\n` +
				`argot.models allowlist. Check the run's session_init model vs arms/<arm>.yml argot.models,\n` +
				`and set the allowlist to the RESOLVED logical id (see report.md "Argot treatment applied?").`,
		);
		process.exitCode = 1;
	}
}

/**
 * Print each treatment arm's predicted saving beside the one it actually delivered.
 *
 * WHY THIS RUNS AUTOMATICALLY RATHER THAN BEING A COMMAND TO REMEMBER. The check
 * that decides whether the instrument can be trusted for the NEXT lever is the gap
 * between predicted and actual, and it was previously three separate commands run
 * from memory with the prediction typed in by hand. A step that has to be
 * remembered is a step that gets skipped on the run where it mattered, and a typed
 * prediction is a copy free to drift from the simulator that produced it. Both
 * halves now come out of this run: the prediction from each arm's parsed overlay
 * against the baseline transcripts just written, the actual from the paired cost
 * delta over the tasks both arms completed.
 *
 * It never fails the run. A missing baseline arm, a lever with no simulator, or a
 * truncated set of trials all produce a printed refusal instead, because this is a
 * diagnostic about the instrument and the reward gate is what decides an arm.
 */
function reportPredictedVsActual(runDir: string, arms: string[], results: ArmResult[]): void {
	const baseline = arms.find(arm => arm === "baseline");
	if (!baseline || arms.length < 2) return;
	const jobsRoot = path.join(runDir, "jobs");
	if (!fs.existsSync(jobsRoot)) return;
	// Read the STAGED overlay from the run directory, not `arms/<arm>.yml` on disk.
	// The staged copy is what the container actually read; the working-tree file is
	// free to have been edited since, and a reaggregate of an old run would then
	// predict from settings that run never used.
	const stagedConfig = (arm: string): unknown => {
		const staged = path.join(runDir, "assets", "arms", `${arm}.yml`);
		if (!fs.existsSync(staged)) return undefined;
		try {
			return YAML.parse(fs.readFileSync(staged, "utf8")) ?? {};
		} catch (err) {
			// Undefined and `{}` are different answers to the caller: `{}` is a staged overlay that set
			// nothing, while undefined means the overlay could not be read, and the prediction is refused
			// rather than computed from settings this run may not have used. Absence is already handled above,
			// so reaching here means the file is there and malformed -- worth saying out loud, because the
			// printed refusal that follows otherwise looks like a run that simply had no overlay.
			console.error(`predicted-vs-actual: staged overlay ${staged} could not be parsed: ${String(err)}`);
			return undefined;
		}
	};
	const measured = measureRunPrefix(jobsRoot, `${baseline}__`);
	if (measured.sessions === 0) {
		console.log("\npredicted vs actual: no baseline transcripts on disk, nothing to predict from.");
		return;
	}
	console.log("\npredicted vs actual saving (prediction derived from this run's own baseline):");
	for (const arm of arms) {
		if (arm === baseline) continue;
		const config = stagedConfig(arm);
		if (config === undefined) {
			// REFUSE rather than predict from the working tree. Guessing here would
			// silently attribute today's settings to yesterday's run.
			console.log(`  ${arm}: no staged arm file in this run, so no prediction can be derived.`);
			continue;
		}
		const prediction = predictArmSaving(arm, config, measured.perSession, measured.mass, measured.usage);
		for (const line of formatArmPrediction(prediction)) console.log(line);
		if (prediction.levers.length === 0) continue;
		// Cost is a SUM, so an arm that completed more tasks looks more expensive for a
		// reason that has nothing to do with its lever. Compare only the shared tasks.
		// DID THE LEVER ACTUALLY FIRE? Reported BEFORE the cost delta and independently
		// of it, because a gap can mean the simulation was wrong or it can mean the
		// setting never took effect, and those need opposite responses. It is also the
		// only question still answerable when the arm billed nothing: transcripts exist
		// for trials that died on quota, and whether the category shrank in them says
		// whether the wiring works.
		const treated = measureRunPrefix(jobsRoot, `${arm}__`);
		if (conversationCollapsed(measured.mass, measured.sessions, treated.mass, treated.sessions)) {
			// A share table over sessions that died at startup reads as a lever that
			// removed every category at once, which is the most impressive output this
			// report can print and means the arm never ran. Refuse it.
			console.log(
				`    ${arm} sessions carry almost no conversation, so its trials died before doing work.` +
					` No composition comparison is possible.`,
			);
		} else if (treated.sessions > 0) {
			const before = prefixShares(measured.mass);
			const after = prefixShares(treated.mass);
			for (const category of PREFIX_CATEGORIES) {
				const moved = after[category] - before[category];
				if (Math.abs(moved) < 0.01) continue;
				console.log(
					`    ${category.padEnd(14)} ${(100 * before[category]).toFixed(1)}% of prefix` +
						`  ->  ${(100 * after[category]).toFixed(1)}%` +
						`  (${moved >= 0 ? "+" : ""}${(100 * moved).toFixed(1)} points)`,
				);
			}
		}
		const comparison = predictedVsActual(onPairedTasks(results, baseline, arm), baseline, arm, prediction.netSaving);
		if (!comparison) {
			console.log(`  ${arm}: no paired trials with usage, so the actual saving cannot be measured.`);
			continue;
		}
		console.log(
			`  ${arm}  actual ${(100 * comparison.actual).toFixed(1)}%` +
				`  vs predicted ${(100 * comparison.predicted).toFixed(1)}%` +
				`  ->  gap ${100 * comparison.gap >= 0 ? "+" : ""}${(100 * comparison.gap).toFixed(1)} points`,
		);
	}
	console.log("  A gap near zero means the simulator can be trusted for the next lever without buying it.");
	console.log("  Cost is not the gate: read the paired sign test on reward first.");
}

await main();
