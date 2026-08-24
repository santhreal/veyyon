// Gallery fixtures for the vibe worker tools (spawn, send, wait, list, kill).
import type { VibeToolDetails } from "../../tools/vibe";
import type { VibeScreenSnapshot } from "../../vibe/runtime";
import type { GalleryFixture } from "./types";

/** Session activity timestamps are offsets from load time so gallery ages stay plausible. */
const FIXTURE_NOW = Date.now();

const runningScreen: VibeScreenSnapshot = {
	id: "fast-1",
	cli: "fast",
	state: "running",
	model: "gpt-5.5-codex",
	turns: 3,
	queued: 0,
	turnStartedAt: FIXTURE_NOW - 42_000,
	turnMessage: "Port the rate limiter to a token bucket and keep the burst test green",
	currentTool: "edit",
	currentToolArgs: "packages/server/src/rate-limit.ts",
	lastIntent: "Rewriting the refill loop",
	trace: ["read packages/server/src/rate-limit.ts", "grep tokenBucket"],
	outputTail: ["Refill now advances by elapsed ms, so a burst cannot mint free tokens."],
	lastActivity: "edit packages/server/src/rate-limit.ts",
	lastActivityAt: FIXTURE_NOW - 1_500,
};

const idleScreen: VibeScreenSnapshot = {
	id: "good-2",
	cli: "good",
	state: "idle",
	model: "claude-opus-4-8",
	turns: 7,
	queued: 1,
	trace: ["bun test packages/server/test/rate-limit.test.ts"],
	outputTail: ["12 pass, 0 fail."],
	lastActivity: "bun test packages/server/test/rate-limit.test.ts",
	lastActivityAt: FIXTURE_NOW - 96_000,
};

const screens: VibeScreenSnapshot[] = [runningScreen, idleScreen];

const spawnDetails: VibeToolDetails = {
	op: "spawn",
	screens: [runningScreen],
	spawned: { id: "fast-1", cli: "fast", jobId: "bg_7" },
};

const sendDetails: VibeToolDetails = {
	op: "send",
	screens,
	send: { id: "fast-1", mode: "steered", jobId: "bg_7" },
};

const waitDetails: VibeToolDetails = {
	op: "wait",
	screens,
	wait: {
		settled: [{ id: "good-2", jobId: "bg_8", status: "completed" }],
		stillRunning: ["fast-1"],
		timedOut: false,
	},
};

const listDetails: VibeToolDetails = { op: "list", screens };

const killDetails: VibeToolDetails = {
	op: "kill",
	screens: [idleScreen],
	killed: { id: "fast-1", cancelledTurn: true },
};

export const vibeFixtures: Record<string, GalleryFixture> = {
	vibe_spawn: {
		label: "Vibe Spawn",
		streamingArgs: { cli: "fast", name: "fast-1" },
		args: {
			cli: "fast",
			name: "fast-1",
			prompt: "Port the rate limiter to a token bucket.\nKeep the burst test green and report the delta.",
		},
		result: { content: [{ type: "text", text: "spawned fast-1" }], details: spawnDetails },
	},

	vibe_send: {
		label: "Vibe Send",
		streamingArgs: { session: "fast-1" },
		args: { session: "fast-1", message: "Use elapsed milliseconds for the refill, not a fixed tick." },
		result: { content: [{ type: "text", text: "steered fast-1" }], details: sendDetails },
	},

	vibe_wait: {
		label: "Vibe Wait",
		args: { sessions: ["fast-1", "good-2"] },
		result: { content: [{ type: "text", text: "good-2 completed" }], details: waitDetails },
	},

	vibe_list: {
		label: "Vibe List",
		args: {},
		result: { content: [{ type: "text", text: "2 sessions" }], details: listDetails },
	},

	vibe_kill: {
		label: "Vibe Kill",
		args: { session: "fast-1" },
		result: { content: [{ type: "text", text: "killed fast-1" }], details: killDetails },
	},
};
