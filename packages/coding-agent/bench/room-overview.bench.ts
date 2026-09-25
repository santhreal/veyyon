/**
 * Room overview bench: what one frame of the open room view costs while its
 * conversations work.
 *
 * The room view repaints on the house spinner cadence while any conversation
 * on it is working, and on every frame a streaming conversation writes. Both
 * run for as long as the view is open, so their per-frame cost is the view's
 * steady-state cost.
 *
 *   ticks:     three windows working with nothing new to show; every frame is
 *              80ms after the last, which moves only the spinners and clocks.
 *   streaming: the same room with one window writing: every frame is 16.7ms
 *              after the last and that window's answer is one word longer.
 *
 * Each scenario runs on two grids in both layouts over the same six
 * conversations, each exchange a prompt and forty blocks of prose and tool
 * rows. The stage is the real `RoomStage` on a manual motion clock, with the
 * opening zoom settled before the first timed frame.
 *
 * Exact parity: the bench prints a digest of every frame it drew. The digest
 * depends only on the corpus, the grid and the clock, so two builds that draw
 * the same frames print the same digest, and a change that claims to draw
 * faster is checked against the build before it by comparing digests.
 *
 * Run: `bun packages/coding-agent/bench/room-overview.bench.ts`.
 */

import { createHash } from "node:crypto";
import {
	type RoomLayout,
	RoomStage,
	type RoomStageHost,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import type {
	RoomFeedBlock,
	RoomStageMember,
	RoomWindowSnapshot,
	RoomWindowState,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { benchFail, benchStats } from "@veyyon/utils/bench-harness";
import { MOTION, MotionClock } from "@veyyon/utils/motion";
import { paragraph } from "../../../hosts/terminal/engine/bench/_harness";

const FRAMES = 300;
const WARMUP = 30;
const FRAME_MS = 1000 / 60;
const SPINNER_MS = 80;
/** A fixed wall clock, so every build draws the same clocks and spinner frames. */
const EPOCH = Date.UTC(2026, 0, 5, 9, 30);
const GRIDS = [
	{ columns: 100, rows: 40 },
	{ columns: 213, rows: 60 },
] as const;
const LAYOUTS: readonly RoomLayout[] = ["side-by-side", "all-windows"];
const BLOCKS = 40;

function exchange(seed: number, running: boolean): RoomFeedBlock[] {
	const blocks: RoomFeedBlock[] = [{ kind: "prompt", text: paragraph(seed, 2) }];
	for (let i = 0; i < BLOCKS; i++) {
		if (i % 3 === 0) blocks.push({ kind: "text", text: paragraph(seed + i, 2 + (i % 3)) });
		else {
			const last = running && i === BLOCKS - 1;
			blocks.push({
				kind: "tool",
				label: i % 2 === 0 ? "Read" : "Run Command",
				detail: `src/module-${seed}-${i}.ts`,
				state: last ? "running" : "ok",
			});
		}
	}
	return blocks;
}

function snapshot(
	id: number,
	state: RoomWindowState,
	blocks: readonly RoomFeedBlock[],
	title?: string,
): RoomWindowSnapshot {
	return { state, blocks, title, model: "claude-sonnet-4", cwd: `~/src/project-${id}` };
}

const working = (activity: "tool" | "thinking" | "writing"): RoomWindowState => ({
	kind: "working",
	since: EPOCH - 41_000,
	activity,
});

/** The words the writing window adds, one a frame. */
const STREAM_WORDS = paragraph(97, 60).split(" ");

interface Room {
	readonly members: RoomStageMember[];
	/** Make the writing window's answer one word longer; a no-op in the ticks scenario. */
	readonly write: (frame: number) => void;
}

function room(streaming: boolean): Room {
	const writingBase = exchange(2, false);
	let writing = snapshot(2, working(streaming ? "writing" : "tool"), exchange(2, !streaming), "parser rewrite");
	const snapshots: RoomWindowSnapshot[] = [
		snapshot(1, { kind: "done", at: EPOCH - 120_000 }, exchange(1, false), "add tests"),
		writing,
		snapshot(3, working("tool"), exchange(3, true), "flaky test"),
		snapshot(4, working("thinking"), exchange(4, false)),
		snapshot(5, { kind: "done", at: EPOCH - 300_000 }, exchange(5, false), "release notes"),
		snapshot(6, { kind: "new" }, []),
	];
	const members: RoomStageMember[] = snapshots.map((_, index) => ({
		id: `c${index + 1}`,
		snapshot: () => (index === 1 ? writing : snapshots[index]!),
		waitingDialogs: 0,
		draft: undefined,
		unread: false,
		origin: index === 0,
	}));
	return {
		members,
		write: frame => {
			if (!streaming) return;
			const answer = STREAM_WORDS.slice(0, (frame % STREAM_WORDS.length) + 1).join(" ");
			writing = snapshot(2, working("writing"), [...writingBase, { kind: "text", text: answer }], "parser rewrite");
		},
	};
}

interface Run {
	readonly samples: number[];
	readonly digest: string;
}

function run(grid: { columns: number; rows: number }, layout: RoomLayout, streaming: boolean): Run {
	const { members, write } = room(streaming);
	const clock = new MotionClock();
	let clockTime = 0;
	let now = EPOCH;
	const host: RoomStageHost = {
		requestRender: () => {},
		rows: () => grid.rows,
		members: () => members,
		prepare: () => Promise.reject(new Error("the overview bench never enters a window")),
		land: () => benchFail("the overview bench never lands"),
		create: () => Promise.reject(new Error("the overview bench never opens a conversation")),
		close: async () => "the overview bench never closes a conversation",
		rename: async () => "the overview bench never names a conversation",
		isToggle: () => false,
		keyInFlight: () => {},
		channel: () => undefined,
	};
	const stage = new RoomStage(host, {
		originId: "c1",
		originScreen: undefined,
		layout,
		mode: { kind: "overview" },
		clock,
		motion: true,
		now: () => now,
	});
	try {
		// The opening zoom settles before the first timed frame.
		for (let t = 0; t <= MOTION.zoom.duration + FRAME_MS * 2; t += FRAME_MS) {
			clockTime += FRAME_MS;
			clock.tick(clockTime);
			stage.render(grid.columns);
		}
		const step = streaming ? FRAME_MS : SPINNER_MS;
		const digest = createHash("sha256");
		const samples: number[] = [];
		for (let frame = 0; frame < WARMUP + FRAMES; frame++) {
			now += step;
			write(frame);
			const start = performance.now();
			const rows = stage.render(grid.columns);
			const ms = performance.now() - start;
			if (rows.length !== grid.rows) benchFail(`a frame drew ${rows.length} rows on a ${grid.rows}-row grid`);
			for (const row of rows) digest.update(row).update("\n");
			if (frame >= WARMUP) samples.push(ms);
		}
		return { samples, digest: digest.digest("hex").slice(0, 12) };
	} finally {
		stage.dispose();
	}
}

await initTheme();

console.log(`\nBenchmark: room-overview (${FRAMES} frames per row after ${WARMUP} untimed)\n`);
console.log("| Grid | Layout | Scenario | mean µs | p50 µs | p95 µs | frames digest |");
console.log("|---|---|---|---|---|---|---|");
for (const grid of GRIDS) {
	for (const layout of LAYOUTS) {
		for (const streaming of [false, true]) {
			const { samples, digest } = run(grid, layout, streaming);
			const stats = benchStats(samples);
			const us = (ms: number): string => (ms * 1000).toFixed(0);
			console.log(
				`| ${grid.columns}x${grid.rows} | ${layout} | ${streaming ? "streaming" : "ticks"} | ${us(stats.mean)} | ${us(stats.p50)} | ${us(stats.p95)} | ${digest} |`,
			);
		}
	}
}
