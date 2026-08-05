import type { AgentToolResult } from "@veyyon/agent-core";
import { collapseWhitespace, prompt } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";

const MUTATION_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
const PROOF_TOOLS: Record<string, true> = { bash: true, eval: true, debug: true, browser: true };
const MAX_EVIDENCE = 32;
const MAX_PENDING_CALLS = 64;
const MAX_PATHS_PER_MUTATION = 12;
const MAX_TEXT_LENGTH = 240;

export const VERIFICATION_EVIDENCE_REMINDER_TYPE = "verification-evidence-reminder";

export interface MutationEvidence {
	sequence: number;
	toolName: "edit" | "write" | "ast_edit";
	paths: readonly string[];
}

export interface ProofEvidence {
	sequence: number;
	/** Exact mutation sequence this proof candidate followed. Absent in legacy snapshots. */
	mutationSequence?: number;
	toolName: "bash" | "eval" | "debug" | "browser";
	summary: string;
}

export interface VerificationLedgerSnapshot {
	mutations: readonly MutationEvidence[];
	proofs: readonly ProofEvidence[];
	intervenedThisTurn: boolean;
	turnStartedAtSequence: number;
}

interface ToolStartEvidence {
	toolName: string;
	summary: string;
	mutationSequenceAtStart?: number;
}

interface ToolStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

interface ToolEnd {
	toolCallId: string;
	toolName: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function boundedText(value: string): string {
	const normalized = collapseWhitespace(value);
	return normalized.length <= MAX_TEXT_LENGTH ? normalized : `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? boundedText(value) : undefined;
}

function summarizeProofCall(toolName: string, args: unknown, intent?: string): string {
	const statedIntent = stringValue(intent);
	if (statedIntent) return statedIntent;
	const input = record(args);
	if (!input) return `${toolName} call`;

	if (toolName === "bash") return stringValue(input.command) ?? "bash call";
	if (toolName === "eval") return stringValue(input.title) ?? stringValue(input.code) ?? "eval call";
	if (toolName === "debug") {
		const action = stringValue(input.action);
		const program = stringValue(input.program);
		return [action, program].filter(Boolean).join(" ") || "debug call";
	}
	if (toolName === "browser") {
		const action = stringValue(input.action);
		const url = stringValue(input.url);
		return [action, url].filter(Boolean).join(" ") || "browser call";
	}
	return `${toolName} call`;
}

function uniquePaths(values: unknown[]): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const path = boundedText(value);
		if (path.length === 0 || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
		if (paths.length === MAX_PATHS_PER_MUTATION) break;
	}
	return paths;
}

function mutationFromResult(toolName: string, detailsValue: unknown): Omit<MutationEvidence, "sequence"> | undefined {
	let effectiveTool = toolName;
	let details = record(detailsValue);
	if (toolName === "resolve" && details?.action === "apply" && details.sourceToolName === "ast_edit") {
		effectiveTool = "ast_edit";
		details = record(details.sourceResultDetails);
	}
	if (!MUTATION_TOOLS[effectiveTool] || !details) return undefined;

	let paths: string[];
	if (effectiveTool === "edit") {
		const perFileResults = Array.isArray(details.perFileResults) ? details.perFileResults : [];
		paths = uniquePaths([
			details.path,
			details.sourcePath,
			...perFileResults.flatMap(result => {
				const perFile = record(result);
				return perFile ? [perFile.path, perFile.sourcePath] : [];
			}),
		]);
	} else if (effectiveTool === "write") {
		paths = uniquePaths([details.resolvedPath]);
	} else {
		if (details.applied !== true || typeof details.totalReplacements !== "number" || details.totalReplacements <= 0) {
			return undefined;
		}
		paths = uniquePaths(Array.isArray(details.files) ? details.files : []);
	}
	if (paths.length === 0) return undefined;
	return { toolName: effectiveTool as MutationEvidence["toolName"], paths };
}

function appendBounded<T>(items: T[], item: T): void {
	items.push(item);
	if (items.length > MAX_EVIDENCE) items.splice(0, items.length - MAX_EVIDENCE);
}

/**
 * Session-owned, bounded evidence state. It observes exact tool completion
 * results and only decides whether one more turn is warranted; it does not
 * claim that a successful command semantically proved the change correct.
 */
export class VerificationEvidenceLedger {
	#sequence = 0;
	#intervenedThisTurn = false;
	#turnStartedAtSequence = 0;
	readonly #mutations: MutationEvidence[] = [];
	readonly #proofs: ProofEvidence[] = [];
	readonly #pendingProofCalls = new Map<string, ToolStartEvidence>();

	startUserTurn(): void {
		this.#intervenedThisTurn = false;
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
		if (event.isError === true || event.result.isError === true) return;

		const mutation = mutationFromResult(event.toolName, event.result.details);
		if (mutation) {
			appendBounded(this.#mutations, { ...mutation, sequence: ++this.#sequence });
			return;
		}
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
			pathsMarkdown: mutation.paths.map(path => `- ${path}`).join("\n"),
		});
	}

	snapshot(): VerificationLedgerSnapshot {
		return {
			mutations: this.#mutations.map(item => ({ ...item, paths: [...item.paths] })),
			proofs: this.#proofs.map(item => ({ ...item })),
			intervenedThisTurn: this.#intervenedThisTurn,
			turnStartedAtSequence: this.#turnStartedAtSequence,
		};
	}
}
