/**
 * Parsing and validation of trial outputs, rewards, patches, and execution metadata.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@veyyon/utils";
import type { ComparisonArmResult, ComparisonExecution, NativeCompactionEvidence } from "../../../engine/arm-result";
import type { ComparisonSystem } from "../../../engine/system-comparison";
import {
	emptyArmResult,
	finishedWithoutPatch,
	isAgentTimeoutException,
	NO_REWARD_ERROR,
	noRewardError,
	providerFinishReason,
	providerQuotaStop,
	quotaStopMarker,
} from "../aggregate/index";
import type { LoadedReplayManifest } from "../replay-manifest";
import { parseSessionsUsage } from "./session-transcript";

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
	if (!isRecord(value)) return null;
	const raw = value as Record<string, unknown>;
	return {
		native: raw.native === true,
		artifact: typeof raw.artifact === "string" ? raw.artifact : "",
		beforeTokens: typeof raw.before_tokens === "number" ? raw.before_tokens : null,
		afterTokens: typeof raw.after_tokens === "number" ? raw.after_tokens : null,
	};
}

/**
 * Whether the trial's agent reached a provider at all.
 *
 * Token counts come from the session transcript when there is one and from pier's own
 * `agent_result` otherwise, so both sources are consulted; a counted agent step covers
 * a provider that reports no usage. All three absent means the container never got as
 * far as a request, which is an infrastructure failure and not a score.
 */
function agentProducedWork(result: ComparisonArmResult, agent: Record<string, unknown>): boolean {
	if ((result.outputTokens ?? 0) > 0 || (result.inputTokens ?? 0) > 0 || (result.cacheTokens ?? 0) > 0) {
		return true;
	}
	return typeof agent.n_agent_steps === "number" && agent.n_agent_steps > 0;
}

export function parseTrialResult(
	arm: string,
	task: string,
	repeat: number,
	jobDir: string,
	comparison: TrialComparisonContext | null = null,
): ComparisonArmResult {
	const result: ComparisonArmResult = emptyArmResult(arm, task, repeat);
	const entries = fs.readdirSync(jobDir, { withFileTypes: true });
	const trialDir = entries.find(d => d.isDirectory());
	if (!trialDir) throw new Error(`no trial dir under ${jobDir}`);
	const trialDirPath = path.join(jobDir, trialDir.name);
	const trialPath = path.join(trialDirPath, "result.json");
	if (!fs.existsSync(trialPath)) {
		result.error = "missing result.json";
		return result;
	}
	const trial = JSON.parse(fs.readFileSync(trialPath, "utf8"));
	const agent =
		trial.agent_result && typeof trial.agent_result === "object"
			? (trial.agent_result as Record<string, unknown>)
			: {};
	const metadata =
		agent.metadata && typeof agent.metadata === "object" ? (agent.metadata as Record<string, unknown>) : {};

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

	const rewards =
		trial.verifier_result?.rewards && typeof trial.verifier_result.rewards === "object"
			? (trial.verifier_result.rewards as Record<string, unknown>)
			: {};
	result.reward = typeof rewards.reward === "number" ? rewards.reward : null;
	result.partial = typeof rewards.partial === "number" ? rewards.partial : null;
	result.f2p = typeof rewards.f2p === "number" ? rewards.f2p : null;
	result.p2p = typeof rewards.p2p === "number" ? rewards.p2p : null;

	const parsed = parseSessionsUsage(trialDirPath);
	if (comparison) {
		result.resolvedModel =
			parsed?.resolvedModel ?? (typeof metadata.resolved_model === "string" ? metadata.resolved_model : null);
	}

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
		result.inputTokens = typeof agent.n_input_tokens === "number" ? agent.n_input_tokens : null;
		result.outputTokens = typeof agent.n_output_tokens === "number" ? agent.n_output_tokens : null;
		result.cacheTokens = typeof agent.n_cache_tokens === "number" ? agent.n_cache_tokens : null;
		result.costUsd = typeof agent.cost_usd === "number" ? agent.cost_usd : null;
		result.argotLoadCalls = typeof metadata.argot_load_calls === "number" ? metadata.argot_load_calls : null;
		result.assistantMsgsWithSigil =
			typeof metadata.assistant_msgs_with_sigil === "number" ? metadata.assistant_msgs_with_sigil : null;
		result.toolCalls =
			metadata.tool_calls && typeof metadata.tool_calls === "object"
				? (metadata.tool_calls as Record<string, number>)
				: null;
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
	// An exception plus "no model.patch in the container" is an honest 0 only when the
	// agent actually ran and produced nothing. A trial that died in agent setup also
	// leaves that line behind, because the artifact download runs after the failure, so
	// scoring it 0 reported an infrastructure failure as a task the model could not
	// solve. Spent tokens or a counted step are the evidence; without either this falls
	// through to the error branch and the trial is reported with no reward at all.
	if (trial.exception_info && finishedWithoutPatch(jobLog) && agentProducedWork(result, agent)) {
		result.reward = 0;
		result.partial = 0;
		result.f2p = 0;
		result.exceptionInfo = isRecord(trial.exception_info) ? trial.exception_info : { detail: trial.exception_info };
		return result;
	}

	// A bounded agent phase is not a failed trial. Pier catches its own agent timeout,
	// downloads the logs, collects the artifacts and still runs the verifier, so the grade
	// the verifier produced is this trial's grade. Reporting the exception as the row's
	// error discarded it, and a run that bounded the agent phase to fit a window measured
	// nothing at all: every row read as a trial that never reached a grader. The bound stays
	// recorded on the row, so a report can state the phase was cut short.
	if (isAgentTimeoutException(trial.exception_info) && result.reward !== null && agentProducedWork(result, agent)) {
		result.exceptionInfo = isRecord(trial.exception_info) ? trial.exception_info : { detail: trial.exception_info };
		return result;
	}

	if (trial.exception_info) {
		let err = JSON.stringify(trial.exception_info).slice(0, 300);
		const systemLogName = comparison?.system ? `${comparison.system}.txt` : "veyyon.txt";
		const agentLog =
			readIfPresent(path.join(trialDirPath, "agent", systemLogName)) ??
			readIfPresent(path.join(trialDirPath, "agent", "veyyon.txt"));
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
