/**
 * Telemetry error types, tool block parsing, and conversation dump materialization.
 *
 * Decodes tool execution outputs, parses assistant raw tool blocks, manages error
 * telemetry objects, and writes session dumps with associated artifact directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatSessionDumpText } from "@veyyon/coding-agent";
import { isRecord } from "@veyyon/utils";
import { pathSegmentFrom } from "../../../engine/package-paths";
import type {
	BenchmarkClient,
	ConversationDumpSnapshot,
	EDIT_TOOL_NAMES,
	PromptAttemptTelemetry,
	PromptTurnLimitTelemetry,
} from "./types";

export class PromptTimeoutError extends Error {
	telemetry: PromptAttemptTelemetry;

	constructor(telemetry: PromptAttemptTelemetry) {
		super("Timeout waiting for agent_end");
		this.name = "PromptTimeoutError";
		this.telemetry = telemetry;
	}
}

export class PromptTurnLimitError extends Error {
	telemetry: PromptTurnLimitTelemetry;

	constructor(telemetry: PromptTurnLimitTelemetry) {
		super(
			`Max turn limit exceeded: observed ${telemetry.observedTurns} turn_start events (limit ${telemetry.maxTurns}).`,
		);
		this.name = "PromptTurnLimitError";
		this.telemetry = telemetry;
	}
}

export function extractToolText(result: unknown): string | null {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return null;
	const content = result.content;
	if (!Array.isArray(content)) return null;
	for (const entry of content) {
		if (!isRecord(entry)) continue;
		const text = entry.text;
		if (typeof text === "string") return text;
	}
	return null;
}

export function extractHashlineWarnings(result: unknown): string[] {
	const text = extractToolText(result);
	if (!text) return [];
	const marker = "Warnings:\n";
	const markerIndex = text.indexOf(marker);
	if (markerIndex === -1) return [];
	return text
		.slice(markerIndex + marker.length)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

export function hasHashlineAutocorrectWarning(warnings: string[]): boolean {
	return warnings.some(warning => warning.startsWith("Auto-corrected "));
}

export function extractToolErrorMessage(result: unknown): string {
	const text = extractToolText(result);
	if (text) return text;
	try {
		return JSON.stringify(result);
	} catch {
		return "Unknown error";
	}
}

export function extractAssistantToolRawBlocks(event: {
	type: string;
	[key: string]: unknown;
}): Array<{ id: string; rawBlock: string }> {
	const message = event.message;
	if (!isRecord(message)) return [];
	if (message.role !== "assistant") return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];
	const rawBlocks: Array<{ id: string; rawBlock: string }> = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type !== "toolCall") continue;
		if (typeof block.id !== "string" || typeof block.rawBlock !== "string") continue;
		rawBlocks.push({ id: block.id, rawBlock: block.rawBlock });
	}
	return rawBlocks;
}

export function getEditPathFromArgs(args: unknown): string | null {
	if (!isRecord(args)) return null;
	const pathValue = args.path;
	return typeof pathValue === "string" && pathValue.length > 0 ? pathValue : null;
}

export function isEditTool(toolName: unknown): toolName is (typeof EDIT_TOOL_NAMES)[number] {
	return toolName === "edit" || toolName === "vim" || toolName === "apply_patch";
}

export function isMutationTool(toolName: unknown): boolean {
	return isEditTool(toolName) || toolName === "write";
}

export function sanitizeDumpPathSegment(value: string): string {
	return pathSegmentFrom(value, "task");
}

export function getConversationDumpPath(dumpDir: string, taskId: string, runIndex: number): string {
	return path.join(dumpDir, sanitizeDumpPathSegment(taskId), `run-${runIndex + 1}.md`);
}

/** Artifacts directory for a session dump file (.md or legacy .jsonl). */
export function dumpArtifactsDir(dumpFilePath: string): string {
	if (dumpFilePath.endsWith(".md")) {
		return dumpFilePath.slice(0, -3);
	}
	if (dumpFilePath.endsWith(".jsonl")) {
		return dumpFilePath.slice(0, -6);
	}
	const ext = path.extname(dumpFilePath);
	return path.join(path.dirname(dumpFilePath), path.basename(dumpFilePath, ext));
}

export async function copyConversationArtifacts(sourceSessionFile: string, targetDumpFile: string): Promise<void> {
	const sourceArtifactsDir = dumpArtifactsDir(sourceSessionFile);
	const targetArtifactsDir = dumpArtifactsDir(targetDumpFile);
	try {
		const stat = await fs.promises.stat(sourceArtifactsDir);
		if (!stat.isDirectory()) return;
		await fs.promises.cp(sourceArtifactsDir, targetArtifactsDir, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

export async function writeConversationDump(params: {
	dumpDir: string;
	taskId: string;
	runIndex: number;
	snapshot: ConversationDumpSnapshot;
}): Promise<string> {
	const dumpPath = getConversationDumpPath(params.dumpDir, params.taskId, params.runIndex);
	await fs.promises.mkdir(path.dirname(dumpPath), { recursive: true });
	const body = formatSessionDumpText({
		messages: params.snapshot.messages,
		systemPrompt: params.snapshot.systemPrompt,
		model: params.snapshot.model,
		thinkingLevel: params.snapshot.thinkingLevel,
		tools: params.snapshot.dumpTools,
	});
	await Bun.write(dumpPath, `${body}\n`);
	if (params.snapshot.sourceSessionFile) {
		await copyConversationArtifacts(params.snapshot.sourceSessionFile, dumpPath);
	}
	return dumpPath;
}

export async function snapshotConversationDump(client: BenchmarkClient): Promise<ConversationDumpSnapshot> {
	const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
	return {
		messages,
		sourceSessionFile: state.sessionFile,
		systemPrompt: state.systemPrompt,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		dumpTools: state.dumpTools,
	};
}

export function formatLogPath(logFile: string, repoRoot: string): string {
	const relativePath = path.relative(repoRoot, logFile);
	return relativePath === "" ? "." : relativePath;
}
