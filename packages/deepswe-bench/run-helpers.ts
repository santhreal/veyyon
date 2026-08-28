#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import {
	collectEmittedText,
	type EncodeHeadroom,
	emptyArmResult,
	encodeHeadroom,
	finishedWithoutPatch,
	NO_REWARD_ERROR,
	noRewardError,
	providerFinishReason,
	providerQuotaStop,
	quotaStopMarker,
	type SessionUsage,
	systemPromptTeachesArgot,
	tallyUsage,
} from "./aggregate";
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
import type { LoadedReplayManifest } from "./replay-manifest";
import type {
	ComparisonArmResult,
	ComparisonExecution,
	ComparisonSystem,
	NativeCompactionEvidence,
} from "./system-comparison";

export const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);
export const CODING_AGENT_DIR = path.resolve(BENCH_DIR, "../coding-agent");
export const VEY_BINARY = path.join(CODING_AGENT_DIR, "dist", "vey");
export const AUTH_DB = path.join(BENCH_DIR, "assets", "auth-agent.db");

export function parseArgs(argv: string[]): Record<string, string> {
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

export function requireFile(p: string, hint: string): void {
	if (!fs.existsSync(p)) {
		console.error(`missing: ${p}\n${hint}`);
		process.exit(1);
	}
}

export async function ensureBinaryUpToDate(): Promise<void> {
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

export const AUTH_DB_SOURCES = [
	path.join(os.homedir(), ".veyyon", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "default", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "work", "shared-auth", "agent.db"),
];

export function ensureAuthDbSeeded(): void {
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

export async function requireStagedAuthCanServeToken(model: string, dryRun = false): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(AUTH_DB);
	let probes: CredentialProbe[];
	try {
		const storage = new AuthStorage(store);
		await storage.reload();
		probes = await storage.checkCredentials();
	} finally {
		store.close();
	}

	const spent = exhaustedPoolFor(probes, model);
	if (spent) {
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
		console.warn(
			`deepswe-bench: WARNING the staged auth DB could NOT be verified. No probe is configured for: ` +
				`${verdict.providers.join(", ")}. Proceeding UNVERIFIED; an auth failure will now surface per trial.`,
		);
		return;
	}
	console.error(describeAuthPreflightFailure(verdict, AUTH_DB));
	process.exit(1);
}

export function sha256File(p: string): string {
	return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function parseSessionsUsage(trialDir: string): {
	usage: SessionUsage;
	resolvedModel: string | null;
	preambleTaught: boolean | null;
	argotHandlesLoaded: number | null;
	handlesTaughtInPrompt: boolean | null;
	promptCacheInvalidations: string[] | null;
	headroom: EncodeHeadroom | null;
} | null {
	const sessionsDir = path.join(trialDir, "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;
	const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
	if (files.length === 0) return null;
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
					preambleTaught = preambleTaught === true || systemPromptTeachesArgot(entry.systemPrompt);
				}
				if (entry.type === "custom_message" && entry.customType === "argot_taught") {
					handlesTaughtInPrompt = handlesTaughtInPrompt === true || entry.details?.inPrompt === true;
				}
				if (entry.type === "custom_message" && entry.customType === "prompt_cache_invalidated") {
					const reason = entry.details?.reason;
					if (typeof reason === "string") promptCacheInvalidations.push(reason);
				}
				if (entry.type === "custom_message" && entry.customType === "argot_armed") {
					const handles = entry.details?.handles;
					if (typeof handles === "number" && Number.isFinite(handles)) {
						argotHandlesLoaded = Math.max(argotHandlesLoaded ?? 0, handles);
					}
					const entries = entry.details?.entries;
					if (entries !== null && typeof entries === "object") {
						const table: Record<string, string> = {};
						for (const [name, expansion] of Object.entries(entries as Record<string, unknown>)) {
							if (typeof expansion === "string") table[name] = expansion;
						}
						if (vocabEntries === null || Object.keys(table).length >= Object.keys(vocabEntries).length) {
							vocabEntries = table;
						}
					}
				}
			} catch {}
		}
	}
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

export function readIfPresent(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}
export interface TrialComparisonContext {
	system: ComparisonSystem;
	requestedModel: string;
	execution: ComparisonExecution;
	replayManifest: LoadedReplayManifest | null;
}

export function artifactPath(metadataValue: unknown, fallback: string, trialDir: string): string {
	if (typeof metadataValue !== "string" || metadataValue.length === 0) return fallback;
	return path.isAbsolute(metadataValue) ? metadataValue : path.resolve(trialDir, metadataValue);
}

export function parsedNativeCompaction(value: unknown): NativeCompactionEvidence | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	return {
		native: raw.native === true,
		artifact: typeof raw.artifact === "string" ? raw.artifact : "",
		beforeTokens: typeof raw.before_tokens === "number" ? raw.before_tokens : null,
		afterTokens: typeof raw.after_tokens === "number" ? raw.after_tokens : null,
	};
}

export function parseTrialResult(
	arm: string,
	task: string,
	repeat: number,
	jobDir: string,
	comparison: TrialComparisonContext | null = null,
): ComparisonArmResult {
	const result: ComparisonArmResult = emptyArmResult(arm, task, repeat);
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
	const jobLog = readIfPresent(path.join(jobDir, "job.log"));
	if (trial.exception_info && finishedWithoutPatch(jobLog)) {
		result.reward = 0;
		result.partial = 0;
		result.f2p = 0;
		return result;
	}
	if (trial.exception_info) {
		let err = JSON.stringify(trial.exception_info).slice(0, 300);
		const agentLog = readIfPresent(path.join(trialDirPath, "agent", "veyyon.txt"));
		if (agentLog) {
			const tail = agentLog.slice(-2000);
			const finish = providerFinishReason(tail);
			if (finish) err += ` finish_reason: ${finish}`;
			const quota = providerQuotaStop(tail);
			if (quota) err += ` ${quotaStopMarker(quota)}`;
		}
		result.error = result.error ? `${result.error}; ${err}` : err;
	}
	if (!result.error && noRewardError(result.reward)) {
		result.error = NO_REWARD_ERROR;
	}
	return result;
}
