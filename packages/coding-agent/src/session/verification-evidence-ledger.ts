import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { collapseWhitespace, formatMore, prompt, trimTrailingSlashes } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";

export const MUTATION_TOOL_NAMES = ["edit", "write", "ast_edit"] as const;
type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];
const MUTATION_TOOLS = new Set<string>(MUTATION_TOOL_NAMES);
const PROOF_TOOLS: Record<string, true> = { bash: true, eval: true, debug: true, browser: true };
const MAX_EVIDENCE = 32;
const MAX_PENDING_CALLS = 64;
const MAX_PATHS_PER_MUTATION = 12;
const MAX_CODE_REVIEW_PATHS = 24;
const MAX_TEXT_LENGTH = 240;

function isMutationToolName(toolName: string): toolName is MutationToolName {
	return MUTATION_TOOLS.has(toolName);
}

function unreachableMutationTool(toolName: never): never {
	throw new Error(`Unhandled mutation tool: ${toolName}`);
}

export const VERIFICATION_EVIDENCE_REMINDER_TYPE = "verification-evidence-reminder";
export const CODE_REVIEW_REMINDER_TYPE = "code-review-reminder";

const NON_CODE_EXTENSIONS: Record<string, true> = {
	".md": true,
	".markdown": true,
	".mdown": true,
	".mkdn": true,
	".mdx": true,
	".txt": true,
	".text": true,
	".rst": true,
	".adoc": true,
	".asciidoc": true,
	".org": true,
	".log": true,
	".7z": true,
	".avi": true,
	".bmp": true,
	".db": true,
	".doc": true,
	".docx": true,
	".epub": true,
	".gif": true,
	".gz": true,
	".ico": true,
	".jpeg": true,
	".jpg": true,
	".mov": true,
	".mp3": true,
	".mp4": true,
	".pdf": true,
	".png": true,
	".rar": true,
	".rtf": true,
	".sqlite": true,
	".sqlite3": true,
	".tar": true,
	".tgz": true,
	".wav": true,
	".webp": true,
	".zip": true,
};

const NON_CODE_FILENAMES: Record<string, true> = {
	license: true,
	licence: true,
	copying: true,
	notice: true,
	changelog: true,
	readme: true,
	".gitignore": true,
	".npmignore": true,
	".dockerignore": true,
	"package-lock.json": true,
	"pnpm-lock.yaml": true,
	"yarn.lock": true,
	"cargo.lock": true,
	"bun.lock": true,
	"bun.lockb": true,
};

export function isCodeFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const basename = normalized.split("/").pop()?.toLowerCase() ?? "";
	if (NON_CODE_FILENAMES[basename]) return false;
	const dotIndex = basename.lastIndexOf(".");
	if (dotIndex <= 0) return true;
	const ext = basename.slice(dotIndex);
	return !NON_CODE_EXTENSIONS[ext];
}
export interface MutationEvidence {
	sequence: number;
	/** The call that produced it, so a reviewer can ask whether it is still in context. */
	toolCallId: string;
	toolName: MutationToolName;
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
	intervenedCodeReviewThisTurn?: boolean;
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

function normalizeMutationPath(value: unknown, cwd?: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const rawPath = boundedText(value).replace(/\\/g, "/");
	if (rawPath.length === 0) return undefined;
	const hasRoot = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath) || rawPath.startsWith("//");
	if (!hasRoot && cwd) {
		return path.posix.normalize(`${trimTrailingSlashes(cwd.replace(/\\/g, "/"))}/${rawPath}`);
	}
	return path.posix.normalize(rawPath);
}

function pathIdentity(filePath: string): string {
	return process.platform === "win32" || /^[A-Za-z]:\//.test(filePath) || filePath.startsWith("//")
		? filePath.toLowerCase()
		: filePath;
}

function uniquePaths(values: unknown[], cwd?: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = normalizeMutationPath(value, cwd);
		if (!normalized) continue;
		const identity = pathIdentity(normalized);
		if (seen.has(identity)) continue;
		seen.add(identity);
		paths.push(normalized);
		if (paths.length === MAX_PATHS_PER_MUTATION) break;
	}
	return paths;
}

function mutationFromResult(
	toolName: string,
	detailsValue: unknown,
	resultFailed: boolean,
): Omit<MutationEvidence, "sequence" | "toolCallId"> | undefined {
	let effectiveTool = toolName;
	let details = record(detailsValue);
	if (toolName === "resolve" && details?.action === "apply" && details.sourceToolName === "ast_edit") {
		effectiveTool = "ast_edit";
		details = record(details.sourceResultDetails);
	}
	if (!isMutationToolName(effectiveTool) || !details) return undefined;

	switch (effectiveTool) {
		case "edit": {
			const perFileResults = Array.isArray(details.perFileResults) ? details.perFileResults : [];
			const successfulPerFilePaths = perFileResults.flatMap(result => {
				const perFile = record(result);
				return perFile && perFile.isError !== true ? [perFile.path, perFile.sourcePath] : [];
			});
			const paths = uniquePaths(
				resultFailed ? successfulPerFilePaths : [details.path, details.sourcePath, ...successfulPerFilePaths],
			);
			return paths.length > 0 ? { toolName: effectiveTool, paths } : undefined;
		}
		case "write": {
			if (resultFailed) return undefined;
			const paths = uniquePaths([details.resolvedPath]);
			return paths.length > 0 ? { toolName: effectiveTool, paths } : undefined;
		}
		case "ast_edit": {
			if (
				details.applied !== true ||
				typeof details.totalReplacements !== "number" ||
				details.totalReplacements <= 0
			) {
				return undefined;
			}
			const paths = uniquePaths(Array.isArray(details.files) ? details.files : [], stringValue(details.cwd));
			return paths.length > 0 ? { toolName: effectiveTool, paths } : undefined;
		}
		default:
			return unreachableMutationTool(effectiveTool);
	}
}

function appendBounded<T>(items: T[], item: T): void {
	items.push(item);
	if (items.length > MAX_EVIDENCE) items.splice(0, items.length - MAX_EVIDENCE);
}

interface CodeReviewEntry {
	path: string;
	/** Every mutation call that touched this path in the window, oldest first. */
	toolCallIds: string[];
}

interface CodeReviewPathSelection {
	entries: CodeReviewEntry[];
	total: number;
}

function selectCodeReviewPaths(mutations: readonly MutationEvidence[], afterSequence: number): CodeReviewPathSelection {
	const entries: CodeReviewEntry[] = [];
	const callsByIdentity = new Map<string, string[]>();
	let total = 0;
	for (const mutation of mutations) {
		if (mutation.sequence <= afterSequence) continue;
		for (const filePath of mutation.paths) {
			if (!isCodeFile(filePath)) continue;
			const identity = pathIdentity(filePath);
			const known = callsByIdentity.get(identity);
			if (known) {
				known.push(mutation.toolCallId);
				continue;
			}
			// Shared with the entry below, so a later mutation of the same path
			// reaches an entry that was already selected.
			const toolCallIds = [mutation.toolCallId];
			callsByIdentity.set(identity, toolCallIds);
			total += 1;
			if (entries.length < MAX_CODE_REVIEW_PATHS) entries.push({ path: filePath, toolCallIds });
		}
	}
	return { entries, total };
}

function escapePromptPath(filePath: string): string {
	return filePath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Renders a bullet list, or the empty string, which a `{{#if}}` block drops. */
function promptPathList(paths: readonly string[]): string {
	return paths.map(filePath => `- ${escapePromptPath(filePath)}`).join("\n");
}

/**
 * Session-owned, bounded evidence state. It observes exact tool completion
 * results and only decides whether one more turn is warranted; it does not
 * claim that a successful command semantically proved the change correct.
 */
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
			omittedNote: omitted > 0 ? `… and ${formatMore("code file", omitted)} beyond these.` : "",
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
