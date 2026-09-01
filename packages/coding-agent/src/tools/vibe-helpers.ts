import type { AgentToolResult } from "@veyyon/agent-core";
import { type } from "arktype";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import {
	type VibeCli,
	type VibeKillOutcome,
	type VibeScreenSnapshot,
	type VibeSendOutcome,
	VibeSessionRegistry,
} from "../vibe/runtime";
import type { ToolSession } from "./index";

export const VIBE_TOOL_NAMES = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

export const vibeSpawnSchema = type({
	cli: type("'fast' | 'good'").describe(
		"worker flavor: fast = low-latency model for mechanical work; good = strong model for hard work",
	),
	"name?": type("string <= 48").describe("optional session name; generated when omitted"),
	prompt: type("string > 0").describe("first instruction; the worker starts with no other context"),
});

export const vibeSendSchema = type({
	session: type("string > 0").describe("session id from vibe_spawn / vibe_list"),
	message: type("string > 0").describe("message for the session; steers mid-turn, else runs as its next turn"),
});

export const vibeWaitSchema = type({
	"sessions?": type("string[]").describe("session ids to watch; omit to watch every session with a turn in flight"),
	"timeout?": type("number > 0").describe("max seconds to wait (default 30)"),
});

export const vibeKillSchema = type({
	session: type("string > 0").describe("session id to terminate"),
});

export const vibeListSchema = type({});

export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

export interface VibeToolDetails {
	op: VibeOp;
	screens: VibeScreenSnapshot[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
		waiting?: boolean;
	};
	killed?: VibeKillOutcome;
}

export function screensOf(session: ToolSession, ids?: string[]): VibeScreenSnapshot[] {
	return VibeSessionRegistry.global().screens(session.getAgentId?.() ?? MAIN_AGENT_ID, ids);
}

export function textResult(text: string, details: VibeToolDetails): AgentToolResult<VibeToolDetails> {
	return { content: [{ type: "text", text }], details };
}
