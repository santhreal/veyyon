import { estimateTokens, measureDecode, type Vocabulary } from "argot";

export interface AssistantLike {
	role: string;
	content?: unknown;
}

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

export interface TranscriptMeasurement {
	handleEmissions: number;
	distinctHandles: number;
	unknownSigils: number;
	codecTokensSaved: number;
}

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
			const saved = estimateTokens(r.expansion) - estimateTokens(vocab.sigil + r.name);
			if (saved > 0) codecTokensSaved += saved;
		}
	}
	return { handleEmissions, distinctHandles: distinct.size, unknownSigils, codecTokensSaved };
}

export interface RunAssemblyInput {
	taskId: string;
	argotEnabled: boolean;
	passed: boolean;
	outputTokens: number;
	vocab: Vocabulary;
	messages: readonly AssistantLike[];
}

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

export interface ArgotRunMeasurement {
	taskId: string;
	argotEnabled: boolean;
	passed: boolean;
	outputTokens: number;
	transcript: TranscriptMeasurement;
}

export interface ArgotCertification {
	pairedTasks: number;
	onPassCount: number;
	offPassCount: number;
	totalHandleEmissions: number;
	totalUnknownSigils: number;
	onOutputTokens: number;
	offOutputTokens: number;
	netOutputTokenDelta: number;
	totalCodecTokensSaved: number;
}

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

export type CertifiedTruth = "adoption" | "net-tokens" | "pass-parity" | "losslessness";

export interface CertificationFailure {
	truth: CertifiedTruth;
	detail: string;
}

export const ALL_TRUTHS: readonly CertifiedTruth[] = ["adoption", "net-tokens", "pass-parity", "losslessness"];

export const EDIT_TASK_TRUTHS: readonly CertifiedTruth[] = ["pass-parity", "losslessness"];

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
