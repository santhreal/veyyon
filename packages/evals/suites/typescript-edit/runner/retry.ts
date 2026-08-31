/**
 * Failure categorization, retry classification, and backoff for edit benchmark attempts.
 *
 * Classifies edit tool failures into diagnostic categories, detects provider errors,
 * and builds retry context prompts with bounded exponential backoff.
 */

import { isRecord } from "@veyyon/utils";
import {
	EDIT_FAILURE_CATEGORIES,
	type EditFailureCategory,
	HL_SUBTYPES,
	type PromptAttemptTelemetry,
	type ProviderFailure,
	type TaskRunResult,
} from "./types";

const AUTH_FAILURE_RE =
	/\b(401|unauthorized|forbidden|invalid api key|invalid key|user not found|authentication|not authenticated|permission denied|access denied)\b/i;

export function getEditPayloadFromArgs(args: unknown): string {
	if (!isRecord(args)) return "";
	if (typeof args.input === "string") return args.input;
	if (typeof args.diff === "string") return args.diff;
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
}

export function categorizeEditFailure(error: string, args: unknown): EditFailureCategory {
	const payload = getEditPayloadFromArgs(args);
	const hasRangeReplacePayload = /^[1-9]\d*[a-z]{2}\.\.[1-9]\d*[a-z]{2}[ \t]*=/m.test(payload);
	if (
		/\\TEXT.* (?:continuation|has been removed)|range[- ]replacement continuation|LidA\.\.LidB=FIRST_LINE/i.test(
			error,
		)
	) {
		return "range-continuation";
	}
	if (/unified-diff syntax|\+Lid[=|]|\+[1-9]\d*[a-z]{2}[=|]/i.test(error)) {
		return "unified-diff";
	}
	if (/No changes made|no changes being made|replacement is identical/i.test(error)) {
		return "no-change";
	}
	if (/hash mismatch|expected hash|stale/i.test(error)) {
		return "hash-mismatch";
	}
	if (hasRangeReplacePayload && /unrecognized op|cannot parse|Lines must start/i.test(error)) {
		return "range-continuation";
	}
	return "other";
}

export function emptyEditFailureCategoryCounts(): Record<EditFailureCategory, number> {
	return Object.fromEntries(EDIT_FAILURE_CATEGORIES.map(category => [category, 0])) as Record<
		EditFailureCategory,
		number
	>;
}

export function countEditFailureCategories(runs: TaskRunResult[]): Record<EditFailureCategory, number> {
	const counts = emptyEditFailureCategoryCounts();
	for (const run of runs) {
		for (const failure of run.editFailures) {
			counts[failure.category ?? "other"] += 1;
		}
	}
	return counts;
}

export function countHashlineEditSubtypes(args: unknown): Record<string, number> {
	const counts: Record<string, number> = Object.fromEntries(HL_SUBTYPES.map(k => [k, 0]));
	if (!isRecord(args)) return counts;
	const edits = args.edits;
	if (!Array.isArray(edits)) return counts;
	for (const edit of edits) {
		if (!isRecord(edit)) continue;
		for (const key of HL_SUBTYPES) {
			if (key in edit) {
				counts[key]++;
				break;
			}
		}
	}
	return counts;
}

export function detectProviderFailure(events: Array<{ type: string; [key: string]: unknown }>): ProviderFailure | null {
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (!isRecord(message)) continue;
		if (message.role !== "assistant") continue;
		const failure = message.errorMessage;
		if (typeof failure !== "string") continue;
		const normalized = failure.trim();
		if (normalized.length === 0) continue;
		return {
			kind: AUTH_FAILURE_RE.test(normalized) ? "auth" : "provider",
			message: normalized,
		};
	}
	return null;
}

export function getProviderFailureRetryDelayMs(retryNumber: number): number {
	const safeRetryNumber = Math.max(1, retryNumber);
	return Math.min(10_000, 1_000 * 2 ** (safeRetryNumber - 1));
}

export function buildTimeoutRetryContext(
	telemetry: PromptAttemptTelemetry,
	retryNumber: number,
	retryLimit: number,
): string {
	return [
		`Previous attempt timed out waiting for agent_end after ${telemetry.elapsedMs}ms.`,
		`Observed events=${telemetry.eventCount}, tool_starts=${telemetry.toolExecutionStarts}, tool_ends=${telemetry.toolExecutionEnds}, message_ends=${telemetry.messageEnds}.`,
		telemetry.lastEventType
			? `Last event type: ${telemetry.lastEventType}.`
			: "No events were observed before timeout.",
		`Timeout retry ${retryNumber}/${retryLimit}: emit one minimal, concrete edit attempt quickly and stop.`,
	].join("\n");
}

export function buildProviderFailureRetryContext(
	failure: ProviderFailure,
	retryNumber: number,
	retryLimit: number,
	delayMs: number,
): string {
	const category = failure.kind === "auth" ? "provider/auth" : "provider";
	return [
		`Previous attempt failed due to a ${category} error.`,
		`Provider error: ${failure.message}`,
		`Retry ${retryNumber}/${retryLimit} after ${delayMs}ms backoff. Resume the requested edit flow once the provider responds successfully.`,
	].join("\n");
}
