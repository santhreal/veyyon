/**
 * Encode and Argot headroom probing, sigil detection, and emitted text analysis.
 */
import { ARGOT_PREAMBLE, DEFAULT_SIGIL } from "argot";

export { ceilingBelowNoise } from "./stats";
export { blockContainsSigil, typeableHandleMass } from "./usage";

export const ARGOT_PREAMBLE_HEADING: string = ARGOT_PREAMBLE.split("\n", 1)[0] ?? "";

export function systemPromptTeachesArgot(systemPrompt: string): boolean {
	return systemPrompt.includes(ARGOT_PREAMBLE_HEADING);
}

export function collectEmittedText(messages: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const rawContent = message.content;
		const content = Array.isArray(rawContent) ? (rawContent as Array<Record<string, unknown>>) : [];
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			if (typeof block.text === "string") parts.push(block.text);
			if (block.type === "toolCall" && block.arguments !== undefined) {
				try {
					parts.push(JSON.stringify(block.arguments));
				} catch {
					// A non-serializable arguments object cannot carry a plain expansion
					// we could have counted; skip it rather than throwing out of a probe.
				}
			}
		}
	}
	return parts.join("\n");
}

export interface EncodeHeadroom {
	emittedChars: number;
	handles: number;
	usableHandles: number;
	maxSavedChars: number;
	maxSavedPct: number;
}

export function encodeHeadroom(
	emitted: string,
	handles: Readonly<Record<string, string>>,
	sigil: string = DEFAULT_SIGIL,
): EncodeHeadroom {
	let usableHandles = 0;
	let maxSavedChars = 0;
	for (const [name, expansion] of Object.entries(handles)) {
		if (expansion.length === 0) continue;
		let occurrences = 0;
		let from = 0;
		for (;;) {
			const at = emitted.indexOf(expansion, from);
			if (at === -1) break;
			occurrences++;
			from = at + expansion.length;
		}
		if (occurrences === 0) continue;
		usableHandles++;
		const perOccurrence = expansion.length - (sigil.length + name.length);
		if (perOccurrence > 0) maxSavedChars += occurrences * perOccurrence;
	}
	return {
		emittedChars: emitted.length,
		handles: Object.keys(handles).length,
		usableHandles,
		maxSavedChars,
		maxSavedPct: emitted.length === 0 ? 0 : (100 * maxSavedChars) / emitted.length,
	};
}

export function interpretEncodeArm(opts: {
	arm: string;
	okRuns: number;
	taught: number;
	handlesLoaded: number | null;
	encoded: number;
	handlesTaught?: number | null;
	handlesTaughtKnown?: number;
}): string | null {
	const { arm, okRuns, taught, handlesLoaded, encoded } = opts;
	const handlesTaught = opts.handlesTaught ?? null;
	const handlesTaughtKnown = opts.handlesTaughtKnown ?? 0;
	if (okRuns === 0 || taught === 0) return null;
	if (encoded > 0) {
		const size = handlesLoaded === null ? "an unknown number of" : `${handlesLoaded}`;
		return (
			`**${arm}**: the model encoded in ${encoded}/${okRuns} runs with ${size} handles loaded — ` +
			"the token delta against this arm is a real argot measurement."
		);
	}
	if (handlesLoaded === null) {
		return (
			`**${arm}**: taught the preamble but encoded in 0/${okRuns} runs, and the loaded vocabulary size is ` +
			"UNKNOWN (this run predates the `argot_armed` telemetry). The 0-encoded result is uninterpretable — " +
			"rerun so the loaded handle count is recorded before reading any token delta as an argot effect."
		);
	}
	if (handlesLoaded === 0) {
		return (
			`**${arm}**: taught the preamble but the launch dictionary loaded 0 handles, so encoding was ` +
			"IMPOSSIBLE — this corpus has no repeated-token mass to compress. The token delta against this arm " +
			"is NOT a measure of argot; pick tasks whose repos carry repeated paths/commands to measure encode."
		);
	}
	if (handlesTaughtKnown > 0 && handlesTaught !== null && handlesTaught < handlesTaughtKnown) {
		return (
			`**${arm}**: ${handlesLoaded} handles loaded, but the handle TABLE reached the model in only ` +
			`${handlesTaught}/${handlesTaughtKnown} runs. This is a HARNESS failure, not a model result: a model ` +
			"taught the notation, shown no handles, and instructed never to invent one has no compliant way to " +
			"encode. Fix the arm before reading anything into the 0-encoded rows or the token delta."
		);
	}
	if (handlesTaughtKnown === 0) {
		return (
			`**${arm}**: ${handlesLoaded} handles were loaded and the model encoded in 0/${okRuns} runs, but this ` +
			"run has no `argot_taught` record, so whether the handle table ever REACHED the model is unknown. " +
			"That makes the result unattributable — it is equally consistent with the model declining to encode " +
			"and with the table never being shown. Rerun on a build that records it before drawing a conclusion."
		);
	}
	return (
		`**${arm}**: ${handlesLoaded} handles were loaded AND taught in ${handlesTaught}/${handlesTaughtKnown} runs, ` +
		`yet the model encoded in 0/${okRuns} — it ignored shorthand it could see. This is a model-adoption ` +
		"result (chargeable to the model), not a corpus limit or a harness gap; the token delta reflects the " +
		"model declining to encode, not argot being ineffective."
	);
}
