/**
 * How a session file stores a job result without repeating result and error text that content holds.
 *
 * The model reads completed jobs in the tool result's content text, where each job's resultText
 * appears inside fenced code blocks and its errorText appears after an Error prefix. When the
 * content text holds either field verbatim, {@link jobResultCodec} drops the text from the written
 * line and records its span in the content text (`resultSpan`, `errorSpan`), restoring it as a slice
 * of that text when the session loads; a result the session records holds the same slice, so the
 * entry holds the text once.
 */
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BuiltinToolName } from "../core/builtin-names";
import {
	type CodedResultContent,
	firstResultText,
	MIN_CODED_TEXT,
	type ResultTextSpan,
	resultTextSpan,
	sliceResultSpan,
} from "../core/output-notice";

/** Each dropped text field of a job snapshot and the span field written in its place. */
const CODED_FIELDS = [
	["resultText", "resultSpan"],
	["errorText", "errorSpan"],
] as const;

/** The span of `text` in `body`, looked for first under the job's own `### <id> [` heading. */
function jobTextSpan(body: string, text: string, jobId: unknown): ResultTextSpan | undefined {
	const heading = typeof jobId === "string" ? body.indexOf(`### ${jobId} [`) : -1;
	return (heading === -1 ? undefined : resultTextSpan(body, text, heading)) ?? resultTextSpan(body, text);
}

/** Each coded field of `job` whose text `body` holds verbatim, with its span field and that text's span. */
function* heldTexts(
	job: Record<string, unknown>,
	body: string,
): Generator<[field: (typeof CODED_FIELDS)[number][0], spanField: string, span: ResultTextSpan]> {
	for (const [field, spanField] of CODED_FIELDS) {
		const text = job[field];
		if (typeof text !== "string" || text.length < MIN_CODED_TEXT) continue;
		const span = jobTextSpan(body, text, job.id);
		if (span !== undefined) yield [field, spanField, span];
	}
}

function slimJob(job: unknown, body: string): unknown {
	if (!isRecord(job)) return job;
	let slimmed: Record<string, unknown> | undefined;
	for (const [field, spanField, span] of heldTexts(job, body)) {
		slimmed ??= { ...job };
		delete slimmed[field];
		slimmed[spanField] = span;
	}
	return slimmed ?? job;
}

/** How a job result is written to a session file and read back. */
export const jobResultCodec: ToolResultCodec = {
	toolName: "job" satisfies BuiltinToolName,
	slim(details, content) {
		const body = firstResultText(content);
		if (!isRecord(details) || !Array.isArray(details.jobs) || body === undefined) return details;
		let changed = false;
		const jobs = details.jobs.map(job => {
			const slimmed = slimJob(job, body);
			if (slimmed !== job) changed = true;
			return slimmed;
		});
		return changed ? { ...details, jobs } : details;
	},
	restore(details, content) {
		if (!isRecord(details) || !Array.isArray(details.jobs)) return;
		const body = firstResultText(content);
		for (const job of details.jobs) {
			if (!isRecord(job)) continue;
			for (const [field, spanField] of CODED_FIELDS) {
				if (job[field] !== undefined) continue;
				const text = sliceResultSpan(body, job[spanField]);
				if (text === undefined) continue;
				job[field] = text;
				delete job[spanField];
			}
		}
	},
	// A recorded job's text the content text holds verbatim becomes a slice of that text, as a load
	// rebuilds it, so the entry holds the text once.
	settle(details, content) {
		const body = firstResultText(content);
		if (!isRecord(details) || !Array.isArray(details.jobs) || body === undefined) return;
		for (const job of details.jobs) {
			if (!isRecord(job)) continue;
			for (const [field, , [start, end]] of heldTexts(job, body)) job[field] = body.slice(start, end);
		}
	},
};

/**
 * The job snapshots a card draws for a job result. A session loaded with the codec registered holds
 * them whole; a transcript read without that restore holds the written form, which is rebuilt here
 * from the result's text.
 */
export function resolveJobSnapshots<T extends object>(
	jobs: readonly T[] | undefined,
	content: CodedResultContent,
): readonly T[] | undefined {
	if (jobs === undefined) return jobs;
	const body = firstResultText(content);
	let resolvedAny = false;
	const resolved = jobs.map(job => {
		const record = job as Record<string, unknown>;
		let copy: Record<string, unknown> | undefined;
		for (const [field, spanField] of CODED_FIELDS) {
			if (record[field] !== undefined || record[spanField] === undefined) continue;
			const text = sliceResultSpan(body, record[spanField]);
			if (text === undefined) continue;
			copy ??= { ...record };
			copy[field] = text;
		}
		if (copy === undefined) return job;
		resolvedAny = true;
		return copy as T;
	});
	return resolvedAny ? resolved : jobs;
}
