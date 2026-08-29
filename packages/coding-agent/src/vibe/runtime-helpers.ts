import { type AgentDefinition, type AgentProgress, oneLineLabel } from "../task/types";
import type { ConfiguredThinkingLevel } from "../thinking";

export type VibeCli = "fast" | "good";

export const VIBE_CLI_AGENT: Record<VibeCli, string> = {
	fast: "sonic",
	good: "deep",
};

export type VibeSessionState = "starting" | "running" | "idle" | "dead";

export interface VibeTraceEntry {
	tool: string;
	args: string;
	endMs: number;
}

export const TURN_TRACE_CAP = 40;
export const TRACE_LINE_MAX = 120;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const RESPONSE_PREVIEW_MAX = 6000;

export interface VibeTurn {
	jobId: string;
	message: string;
	startedAt: number;
	trace: VibeTraceEntry[];
	toolCount: number;
}

export interface VibeRecord {
	id: string;
	cli: VibeCli;
	ownerId: string;
	agent: AgentDefinition;
	modelOverride?: string | string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	state: VibeSessionState;
	createdAt: number;
	lastActivityAt: number;
	lastActivity?: string;
	resolvedModel?: string;
	turn?: VibeTurn;
	live?: {
		currentTool?: string;
		currentToolArgs?: string;
		lastIntent?: string;
		outputTail: string[];
	};
	lastJobId?: string;
	queue: string[];
	turnCount: number;
	killed: boolean;
}

export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	turnStartedAt?: number;
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	trace: string[];
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

export interface VibeSendOutcome {
	id: string;
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

export interface VibeKillOutcome {
	id: string;
	cancelledTurn: boolean;
}

export interface VibeWaitOutcome {
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	stillRunning: string[];
	timedOut: boolean;
}

export function firstLine(text: string, max = 100): string {
	return oneLineLabel(text, max);
}

export function mergeTrace(turn: VibeTurn, progress: AgentProgress): void {
	turn.toolCount = progress.toolCount;
	for (let i = progress.recentTools.length - 1; i >= 0; i--) {
		const entry = progress.recentTools[i];
		if (turn.trace.some(seen => seen.endMs === entry.endMs && seen.tool === entry.tool && seen.args === entry.args)) {
			continue;
		}
		turn.trace.push({ tool: entry.tool, args: entry.args, endMs: entry.endMs });
		if (turn.trace.length > TURN_TRACE_CAP) turn.trace.shift();
	}
}
