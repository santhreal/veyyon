/**
 * Argot certification core: the deterministic truth engine of the adoption
 * benchmark.
 *
 * The unit tests over the codec prove the MECHANISM is lossless; they cannot
 * prove the FEATURE works, because "works" is an economic claim about a real
 * model: given the shorthand, the model adopts handles and nets a token saving,
 * losslessly, without losing task success. That claim is only settled by running
 * a real model and measuring. This module is the measurement + verdict layer:
 * given paired "argot on" / "argot off" task runs, it computes the four numbers
 * that decide the claim and fails loudly unless all four hold.
 *
 * Everything here is pure and deterministic. The one irreducibly live part — the
 * model call that produces the transcripts — lives in the runner; this file is
 * exhaustively unit-tested so the verdict itself is never in doubt.
 */
import { estimateTokens, measureDecode, type Vocabulary } from "argot";

/**
 * The subset of an assistant message this module reads. Kept structural (not the
 * full `AssistantMessage`) so it accepts both the agent-core and ai message
 * shapes without a coupling to either package's exact type.
 */
export interface AssistantLike {
	role: string;
	/** Present on message roles that carry content parts; absent on summary roles. */
	content?: unknown;
}

/**
 * Every string a model actually emitted in an assistant turn: visible text, and
 * for each tool call its stringified arguments and its intent line. These are the
 * strings that would carry a `§handle`, so they are exactly what adoption and
 * leak measurement must scan. User and tool-result messages are never walked:
 * their handles (if any) are raw human text, not model output.
 */
export function collectEmittedStrings(messages: readonly AssistantLike[]): string[] {
	const out: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part === null || typeof part !== "object") {
				continue;
			}
			if (part.type === "text" && typeof part.text === "string") {
				out.push(part.text);
			} else if (part.type === "toolCall") {
				if (part.arguments !== undefined) {
					out.push(JSON.stringify(part.arguments));
				}
				if (typeof part.intent === "string") {
					out.push(part.intent);
				}
			}
		}
	}
	return out;
}

/** Adoption and leak totals for one run's assistant transcript, measured against a vocabulary. */
export interface TranscriptMeasurement {
	/** Total known-handle emissions (adoption) across every emitted string. */
	handleEmissions: number;
	/** Distinct handle names the model used at least once. */
	distinctHandles: number;
	/** Total sigils that did NOT resolve to a handle (raw-shorthand leaks). */
	unknownSigils: number;
	/**
	 * Deterministic tokens the codec saved on THIS transcript: summed over every
	 * adopted emission, `tokens(expansion) - tokens(handle)` (never negative — a
	 * handle longer than its expansion saves nothing, not a loss, because the codec
	 * only teaches handles that are shorter). This is a pure function of what the
	 * model emitted and the vocabulary, independent of how verbose the reply was, so
	 * it is the honest measure of the codec's value — unlike raw output-token delta,
	 * which is dominated by generation-length nondeterminism across on/off runs.
	 */
	codecTokensSaved: number;
}

/**
 * Measure a run's emitted strings for adoption and leaks using the codec's own
 * instrumented decode ({@link measureDecode}), so the measurement can never
 * disagree with what production expansion actually does.
 */
export function measureTranscript(vocab: Vocabulary, emitted: readonly string[]): TranscriptMeasurement {
	let handleEmissions = 0;
	let unknownSigils = 0;
	let codecTokensSaved = 0;
	const distinct = new Set<string>();
	for (const text of emitted) {
		const m = measureDecode(vocab, text);
		handleEmissions += m.replacements.length;
		unknownSigils += m.unknownSigilCount;
		for (const r of m.replacements) {
			distinct.add(r.name);
			// The handle as emitted is `<sigil><name>`; compare its token cost to the
			// expansion it stood in for. Clamp at 0 so a (never-taught) longer handle
			// cannot subtract from the saving.
			const saved = estimateTokens(r.expansion) - estimateTokens(vocab.sigil + r.name);
			if (saved > 0) codecTokensSaved += saved;
		}
	}
	return { handleEmissions, distinctHandles: distinct.size, unknownSigils, codecTokensSaved };
}

/** Inputs to {@link assembleRunMeasurement}: everything one task run produced. */
export interface RunAssemblyInput {
	taskId: string;
	argotEnabled: boolean;
	/** Whether the run produced the expected files. */
	passed: boolean;
	/** Output tokens the model generated (from session stats). */
	outputTokens: number;
	/** The vocabulary the session armed, used to measure adoption in the transcript. */
	vocab: Vocabulary;
	/** The run's messages; only assistant turns are scanned for handle emissions. */
	messages: readonly AssistantLike[];
}

/**
 * Assemble one {@link ArgotRunMeasurement} from a finished task run: verify result,
 * output tokens, and the adoption/leak measurement of the assistant transcript. A
 * pure function of its inputs, so the live runner's per-task bookkeeping is tested
 * without a model in the loop.
 */
export function assembleRunMeasurement(input: RunAssemblyInput): ArgotRunMeasurement {
	const emitted = collectEmittedStrings(input.messages);
	return {
		taskId: input.taskId,
		argotEnabled: input.argotEnabled,
		passed: input.passed,
		outputTokens: input.outputTokens,
		transcript: measureTranscript(input.vocab, emitted),
	};
}

/** One measured task run under a single argot setting. */
export interface ArgotRunMeasurement {
	taskId: string;
	/** Whether argot was enabled for this run. */
	argotEnabled: boolean;
	/** Whether the run produced the expected files (byte-for-byte, formatter-normalized). */
	passed: boolean;
	/** Output tokens the model generated for this run (from session stats). */
	outputTokens: number;
	/** Adoption + leak measurement of this run's transcript (all zero for an argot-off run). */
	transcript: TranscriptMeasurement;
}

/** The four-truth verdict computed from paired on/off runs over the same tasks. */
export interface ArgotCertification {
	/** Number of tasks that have BOTH an on and an off run (the paired set). */
	pairedTasks: number;
	/** Tasks passed with argot on / off. */
	onPassCount: number;
	offPassCount: number;
	/** Total adoption across the argot-on runs. Truth #1 requires this > 0. */
	totalHandleEmissions: number;
	/** Total raw-sigil leaks across the argot-on runs. Truth #4 requires this === 0. */
	totalUnknownSigils: number;
	/** Output tokens summed across argot-on / argot-off runs (paired tasks only). */
	onOutputTokens: number;
	offOutputTokens: number;
	/**
	 * onOutputTokens − offOutputTokens. INFORMATIONAL ONLY: this is dominated by
	 * generation-length nondeterminism (the model narrates a different amount on each
	 * run), so it is reported but NOT a certified truth. The certified net-value
	 * signal is {@link totalCodecTokensSaved}.
	 */
	netOutputTokenDelta: number;
	/**
	 * Deterministic tokens the codec saved across the argot-on runs (Σ over adopted
	 * emissions of `tokens(expansion) − tokens(handle)`). Truth #2 requires this > 0:
	 * the model actually abbreviated real strings and each handle was shorter than
	 * what it replaced. Unlike {@link netOutputTokenDelta} this is a pure function of
	 * the emitted handles, so it is stable across runs and is the honest measure of
	 * whether argot delivered value.
	 */
	totalCodecTokensSaved: number;
}

/**
 * Pair up on/off runs by task id and compute the certification totals. Only tasks
 * present in BOTH sets count toward the token delta and pass parity, so a task
 * that errored under one setting cannot skew the comparison. Extra runs of the
 * same task+setting are summed (repeated runs raise signal against model noise).
 */
export function certifyArgot(
	onRuns: readonly ArgotRunMeasurement[],
	offRuns: readonly ArgotRunMeasurement[],
): ArgotCertification {
	const onByTask = groupByTask(onRuns);
	const offByTask = groupByTask(offRuns);
	const pairedIds = [...onByTask.keys()].filter(id => offByTask.has(id));

	let onPassCount = 0;
	let offPassCount = 0;
	let totalHandleEmissions = 0;
	let totalUnknownSigils = 0;
	let totalCodecTokensSaved = 0;
	let onOutputTokens = 0;
	let offOutputTokens = 0;

	for (const id of pairedIds) {
		for (const run of onByTask.get(id)!) {
			if (run.passed) onPassCount++;
			totalHandleEmissions += run.transcript.handleEmissions;
			totalUnknownSigils += run.transcript.unknownSigils;
			totalCodecTokensSaved += run.transcript.codecTokensSaved;
			onOutputTokens += run.outputTokens;
		}
		for (const run of offByTask.get(id)!) {
			if (run.passed) offPassCount++;
			offOutputTokens += run.outputTokens;
		}
	}

	return {
		pairedTasks: pairedIds.length,
		onPassCount,
		offPassCount,
		totalHandleEmissions,
		totalUnknownSigils,
		onOutputTokens,
		offOutputTokens,
		netOutputTokenDelta: onOutputTokens - offOutputTokens,
		totalCodecTokensSaved,
	};
}

function groupByTask(runs: readonly ArgotRunMeasurement[]): Map<string, ArgotRunMeasurement[]> {
	const map = new Map<string, ArgotRunMeasurement[]>();
	for (const run of runs) {
		const list = map.get(run.taskId);
		if (list) list.push(run);
		else map.set(run.taskId, [run]);
	}
	return map;
}

/** One of the four certified truths. */
export type CertifiedTruth = "adoption" | "net-tokens" | "pass-parity" | "losslessness";

/** A named reason a certification failed, for a precise operator-facing message. */
export interface CertificationFailure {
	truth: CertifiedTruth;
	detail: string;
}

/** All four truths — the default certification scope. */
export const ALL_TRUTHS: readonly CertifiedTruth[] = ["adoption", "net-tokens", "pass-parity", "losslessness"];

/**
 * The truths a task class can honestly certify. The minimal-edit fixtures
 * reproduce ~no dictionary content, so adoption/net-tokens are structurally
 * unmeasurable there (proven by the forced-adoption probe: the model adopts
 * 100% when reproduction is forced, but an edit task never forces it) — they
 * certify SAFETY only. The content-reproduction tasks exercise the real argot
 * use case and certify VALUE on top.
 */
export const EDIT_TASK_TRUTHS: readonly CertifiedTruth[] = ["pass-parity", "losslessness"];

/**
 * The truths, evaluated — all four by default, or the subset a task class can
 * honestly measure (`truths`). Returns every failure (not just the first) so
 * one run surfaces all of what is broken. An empty array means the feature is
 * certified for that scope: within it, a real model adopted handles and the
 * codec deterministically saved tokens, losslessly, with no loss of task
 * success.
 *
 * Net value is certified on {@link ArgotCertification.totalCodecTokensSaved} —
 * a pure function of the emitted handles — never on the raw output-token
 * delta, which is dominated by generation-length nondeterminism and is
 * reported in the failure detail as context only.
 */
export function evaluateCertification(
	cert: ArgotCertification,
	truths: readonly CertifiedTruth[] = ALL_TRUTHS,
): CertificationFailure[] {
	const failures: CertificationFailure[] = [];
	const wants = new Set(truths);
	if (cert.pairedTasks === 0) {
		failures.push({ truth: truths[0] ?? "adoption", detail: "no paired on/off task runs to certify" });
		return failures;
	}
	if (wants.has("adoption") && cert.totalHandleEmissions <= 0) {
		failures.push({
			truth: "adoption",
			detail: `the model emitted 0 handles across ${cert.pairedTasks} tasks (want > 0)`,
		});
	}
	if (wants.has("net-tokens") && cert.totalCodecTokensSaved <= 0) {
		failures.push({
			truth: "net-tokens",
			detail: `the codec saved ${cert.totalCodecTokensSaved} tokens across adopted emissions (want > 0); raw output delta ${cert.netOutputTokenDelta >= 0 ? "+" : ""}${cert.netOutputTokenDelta} (informational: ${cert.onOutputTokens} on, ${cert.offOutputTokens} off)`,
		});
	}
	if (wants.has("pass-parity") && cert.onPassCount < cert.offPassCount) {
		failures.push({
			truth: "pass-parity",
			detail: `argot on passed ${cert.onPassCount} tasks vs ${cert.offPassCount} off (on must not regress task success)`,
		});
	}
	if (wants.has("losslessness") && cert.totalUnknownSigils > 0) {
		failures.push({
			truth: "losslessness",
			detail: `${cert.totalUnknownSigils} raw sigils leaked unexpanded (want 0): a handle reached output without a matching definition`,
		});
	}
	return failures;
}

/**
 * Throw with a precise, multi-line message unless the certification passes the
 * requested truths (all four by default; pass {@link EDIT_TASK_TRUTHS} for the
 * safety-only edit-task class). This is what a benchmark test calls to turn
 * the measured numbers into a hard pass/fail: if these do not hold, argot does
 * not "work" for that scope, and the suite must be red.
 */
export function assertArgotCertified(cert: ArgotCertification, truths: readonly CertifiedTruth[] = ALL_TRUTHS): void {
	const failures = evaluateCertification(cert, truths);
	if (failures.length === 0) {
		return;
	}
	const lines = failures.map(f => `  - [${f.truth}] ${f.detail}`);
	throw new Error(
		`Argot certification FAILED (${failures.length}/${truths.length} truths unmet):\n${lines.join("\n")}`,
	);
}
