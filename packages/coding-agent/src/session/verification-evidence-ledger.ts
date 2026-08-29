import { prompt } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";
import type {
	MutationEvidence,
	ProofEvidence,
	ToolEnd,
	ToolStart,
	ToolStartEvidence,
	VerificationLedgerSnapshot,
} from "./verification-evidence-ledger-helpers";
import {
	appendBounded,
	boundedText,
	escapePromptPath,
	MAX_EVIDENCE,
	MAX_PATHS_PER_MUTATION,
	MAX_PENDING_CALLS,
	mutationFromResult,
	PROOF_TOOLS,
	promptPathList,
	selectCodeReviewPaths,
	summarizeProofCall,
} from "./verification-evidence-ledger-helpers";

export {
	CODE_REVIEW_REMINDER_TYPE,
	isCodeFile,
	MUTATION_TOOL_NAMES,
	VERIFICATION_EVIDENCE_REMINDER_TYPE,
} from "./verification-evidence-ledger-helpers";

export class VerificationEvidenceLedger {
	#sequence = 0;
	#intervenedThisTurn = false;
	#intervenedCodeReviewThisTurn = false;
	#turnStartedAtSequence = 0;
	readonly #mutations: MutationEvidence[] = [];
	readonly #proofs: ProofEvidence[] = [];
	readonly #pendingProofCalls = new Map<string, ToolStartEvidence>();

	startUserTurn(): void {
		this.#intervenedThisTurn = false;
		this.#intervenedCodeReviewThisTurn = false;
		this.#turnStartedAtSequence = this.#sequence;
	}

	restore(snapshot: VerificationLedgerSnapshot): void {
		const mutations = snapshot.mutations.slice(-MAX_EVIDENCE).map(item => ({
			...item,
			paths: item.paths.slice(0, MAX_PATHS_PER_MUTATION).map(path => boundedText(path)),
		}));
		const proofs = snapshot.proofs.slice(-MAX_EVIDENCE).map(item => ({
			...item,
			summary: boundedText(item.summary),
		}));
		this.#mutations.splice(0, this.#mutations.length, ...mutations);
		this.#proofs.splice(0, this.#proofs.length, ...proofs);
		this.#pendingProofCalls.clear();
		this.#sequence = Math.max(
			0,
			...this.#mutations.map(item => item.sequence),
			...this.#proofs.map(item => item.sequence),
		);
		this.#intervenedThisTurn = snapshot.intervenedThisTurn;
		this.#intervenedCodeReviewThisTurn = snapshot.intervenedCodeReviewThisTurn ?? false;
		this.#turnStartedAtSequence = Math.min(snapshot.turnStartedAtSequence, this.#sequence);
	}

	recordToolStart(event: ToolStart): void {
		if (!PROOF_TOOLS[event.toolName]) return;
		this.#pendingProofCalls.set(event.toolCallId, {
			toolName: event.toolName,
			summary: summarizeProofCall(event.toolName, event.args, event.intent),
			mutationSequenceAtStart: this.#mutations.at(-1)?.sequence,
		});
		while (this.#pendingProofCalls.size > MAX_PENDING_CALLS) {
			const oldest = this.#pendingProofCalls.keys().next().value;
			if (oldest === undefined) break;
			this.#pendingProofCalls.delete(oldest);
		}
	}

	recordToolEnd(event: ToolEnd): void {
		const pendingProof = this.#pendingProofCalls.get(event.toolCallId);
		this.#pendingProofCalls.delete(event.toolCallId);
		const resultFailed = event.isError === true || event.result.isError === true;
		const mutation = mutationFromResult(event.toolName, event.result.details, resultFailed);
		if (mutation) {
			appendBounded(this.#mutations, { ...mutation, toolCallId: event.toolCallId, sequence: ++this.#sequence });
			return;
		}
		if (resultFailed) return;
		if (
			!pendingProof ||
			pendingProof.toolName !== event.toolName ||
			pendingProof.mutationSequenceAtStart === undefined ||
			pendingProof.mutationSequenceAtStart !== this.#mutations.at(-1)?.sequence
		) {
			return;
		}
		appendBounded(this.#proofs, {
			sequence: ++this.#sequence,
			mutationSequence: pendingProof.mutationSequenceAtStart,
			toolName: pendingProof.toolName as ProofEvidence["toolName"],
			summary: pendingProof.summary,
		});
	}

	/** Returns one targeted reminder at most once in the current user turn. */
	takeFinalizationReminder(): string | undefined {
		if (this.#intervenedThisTurn) return undefined;
		const mutation = this.#mutations.at(-1);
		if (!mutation) return undefined;
		const proof = this.#proofs.at(-1);
		if (mutation.sequence <= this.#turnStartedAtSequence) return undefined;
		if (proof && proof.mutationSequence === mutation.sequence && proof.sequence > mutation.sequence) return undefined;

		this.#intervenedThisTurn = true;
		return prompt.render(sessionPrompts["session/verification-evidence-reminder"].text, {
			toolName: mutation.toolName,
			pathsMarkdown: mutation.paths.map(filePath => `- ${escapePromptPath(filePath)}`).join("\n"),
		});
	}

	/**
	 * Returns a review of every code file this user turn changed, at most once
	 * in the turn. A path whose every recorded mutation call has left the
	 * context window is listed apart: the model cannot judge a change it can no
	 * longer see, so it is told to read that file first.
	 */
	takeCodeReviewReminder(isInContext: (toolCallId: string) => boolean): string | undefined {
		if (this.#intervenedCodeReviewThisTurn) return undefined;
		const selection = selectCodeReviewPaths(this.#mutations, this.#turnStartedAtSequence);
		if (selection.total === 0) return undefined;

		this.#intervenedCodeReviewThisTurn = true;
		const visible: string[] = [];
		const unreadable: string[] = [];
		for (const entry of selection.entries) {
			(entry.toolCallIds.some(isInContext) ? visible : unreadable).push(entry.path);
		}
		const omitted = selection.total - selection.entries.length;
		return prompt.render(sessionPrompts["session/code-review-reminder"].text, {
			pathsMarkdown: promptPathList(visible),
			unreadablePathsMarkdown: promptPathList(unreadable),
			omittedNote: omitted > 0 ? `… and ${omitted} more code file${omitted === 1 ? "" : "s"} beyond these.` : "",
		});
	}

	snapshot(): VerificationLedgerSnapshot {
		return {
			mutations: this.#mutations.map(item => ({ ...item, paths: [...item.paths] })),
			proofs: this.#proofs.map(item => ({ ...item })),
			intervenedThisTurn: this.#intervenedThisTurn,
			intervenedCodeReviewThisTurn: this.#intervenedCodeReviewThisTurn,
			turnStartedAtSequence: this.#turnStartedAtSequence,
		};
	}
}
