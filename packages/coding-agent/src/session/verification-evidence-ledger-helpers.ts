import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { collapseWhitespace, trimTrailingSlashes } from "@veyyon/utils";

export const MUTATION_TOOL_NAMES = ["edit", "write", "ast_edit"] as const;
export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];
export const MUTATION_TOOLS = new Set<string>(MUTATION_TOOL_NAMES);
export const PROOF_TOOLS: Record<string, true> = { bash: true, eval: true, debug: true, browser: true };
export const MAX_EVIDENCE = 32;
export const MAX_PENDING_CALLS = 64;
export const MAX_PATHS_PER_MUTATION = 12;
export const MAX_CODE_REVIEW_PATHS = 24;
export const MAX_TEXT_LENGTH = 240;

function isMutationToolName(toolName: string): toolName is MutationToolName {
	return MUTATION_TOOLS.has(toolName);
}

function unreachableMutationTool(toolName: never): never {
	throw new Error(`Unhandled mutation tool: ${toolName}`);
}

export const VERIFICATION_EVIDENCE_REMINDER_TYPE = "verification-evidence-reminder";
export const CODE_REVIEW_REMINDER_TYPE = "code-review-reminder";

export const NON_CODE_EXTENSIONS: Record<string, true> = {
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

export const NON_CODE_FILENAMES: Record<string, true> = {
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

export interface ToolStartEvidence {
	toolName: string;
	summary: string;
	mutationSequenceAtStart?: number;
}

export interface ToolStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

export interface ToolEnd {
	toolCallId: string;
	toolName: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function boundedText(value: string): string {
	const normalized = collapseWhitespace(value);
	return normalized.length <= MAX_TEXT_LENGTH ? normalized : `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? boundedText(value) : undefined;
}

export function summarizeProofCall(toolName: string, args: unknown, intent?: string): string {
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

export function uniquePaths(values: unknown[], cwd?: string): string[] {
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

export function mutationFromResult(
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

export function appendBounded<T>(items: T[], item: T): void {
	items.push(item);
	if (items.length > MAX_EVIDENCE) items.splice(0, items.length - MAX_EVIDENCE);
}

export interface CodeReviewEntry {
	path: string;
	/** Every mutation call that touched this path in the window, oldest first. */
	toolCallIds: string[];
}

export interface CodeReviewPathSelection {
	entries: CodeReviewEntry[];
	total: number;
}

export function selectCodeReviewPaths(
	mutations: readonly MutationEvidence[],
	afterSequence: number,
): CodeReviewPathSelection {
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

export function escapePromptPath(filePath: string): string {
	return filePath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Renders a bullet list, or the empty string, which a `{{#if}}` block drops. */
export function promptPathList(paths: readonly string[]): string {
	return paths.map(filePath => `- ${escapePromptPath(filePath)}`).join("\n");
}

/**
 * Session-owned, bounded evidence state. It observes exact tool completion
 * results and only decides whether one more turn is warranted; it does not
 * claim that a successful command semantically proved the change correct.
 */
