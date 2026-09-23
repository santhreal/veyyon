/**
 * Room view bench: what switching conversations through the room costs over
 * the plain switch.
 *
 * Both arms run on the real engine (`TUI` over a sink terminal with a manual
 * render scheduler, the engine bench harness) and switch between two
 * conversations of the same size, back and forth, on the same grid.
 *
 *   off: today's plain switch. The next conversation's components replace the
 *        root children, then one forced paint with the scrollback cleared.
 *   on:  the room's quick switch. A `RoomStage` in travel mode is shown as the
 *        fullscreen overlay the room controller shows, driven frame by frame on
 *        a manual motion clock through the pull back and the slide; its host
 *        swaps the children and composes the next screen when asked to prepare,
 *        and on the land lifts the overlay and makes the same forced paint.
 *
 * Exact parity: after every switch both arms leave the terminal showing the
 * same committed screen for the same conversation, row for row, and the bench
 * fails otherwise. So the on arm's extra cost is the stage frames alone.
 *
 * Guards: the on arm lands exactly once per switch and never again after it,
 * and enters and leaves the alternate screen exactly once per switch; the off
 * arm never enters it.
 *
 * Run: `bun packages/coding-agent/bench/room-view.bench.ts`.
 */

import { RoomStage, type RoomStageHost } from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import type {
	RoomStageMember,
	RoomWindowSnapshot,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, type OverlayHandle, type OverlayOptions, Text, TUI } from "@veyyon/tui";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "@veyyon/tui/core/terminal-session";
import { benchFail, benchStats } from "@veyyon/utils/bench-harness";
import { MOTION, MotionClock } from "@veyyon/utils/motion";
import { ManualScheduler, paragraph, SinkTerminal } from "../../../hosts/terminal/engine/bench/_harness";

const SWITCHES = 40;
const WARMUP = 4;
const FRAME_MS = 1000 / 60;
/** A travel is a pull back and a slide; past this many frames it is not landing. */
const MAX_STAGE_FRAMES = Math.ceil((MOTION.expand.duration + MOTION.travel.duration) / FRAME_MS) + 10;
const GRIDS = [
	{ columns: 100, rows: 40 },
	{ columns: 213, rows: 60 },
] as const;
const CORPORA = [50, 500] as const;
/** The overlay options `RoomController.#showStage` shows the stage with. */
const ROOM_OVERLAY: OverlayOptions = {
	anchor: "top-left",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
};

/** A sink terminal that also counts the alternate-screen switches it is sent. */
class RecordingTerminal extends SinkTerminal {
	altEnters = 0;
	altExits = 0;

	override write(data: string): void {
		super.write(data);
		this.altEnters += data.split(ALT_SCREEN_ENTER).length - 1;
		this.altExits += data.split(ALT_SCREEN_EXIT).length - 1;
	}
}

interface Conversation {
	readonly id: string;
	readonly children: readonly Component[];
	readonly snapshot: RoomWindowSnapshot;
}

function conversation(id: string, blocks: number, seed: number): Conversation {
	return {
		id,
		children: Array.from({ length: blocks }, (_, i) => new Text(paragraph(seed + i, 2 + (i % 4)))),
		snapshot: {
			state: { kind: "done", at: 0 },
			blocks: [{ kind: "prompt", text: `conversation ${id}` }],
			title: `conversation ${id}`,
			lead: undefined,
			model: "model-x",
			cwd: "~/repo",
		},
	};
}

interface Env {
	readonly tui: TUI;
	readonly terminal: RecordingTerminal;
	readonly scheduler: ManualScheduler;
}

function show(tui: TUI, next: Conversation): void {
	tui.clear();
	for (const child of next.children) tui.addChild(child);
}

function makeEnv(grid: { columns: number; rows: number }, first: Conversation): Env {
	const terminal = new RecordingTerminal(grid.columns, grid.rows);
	const scheduler = new ManualScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	show(tui, first);
	tui.start();
	tui.requestRender();
	scheduler.flush();
	return { tui, terminal, scheduler };
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

interface SwitchSample {
	readonly ms: number;
	readonly bytes: number;
	readonly stageFrames: number;
	readonly stageBytes: number;
	readonly screen: readonly string[];
}

function plainSwitch(env: Env, next: Conversation): SwitchSample {
	const { tui, terminal, scheduler } = env;
	const bytes = terminal.bytes;
	const start = performance.now();
	show(tui, next);
	tui.requestRender(true, { clearScrollback: true });
	scheduler.flush();
	const ms = performance.now() - start;
	return {
		ms,
		bytes: terminal.bytes - bytes,
		stageFrames: 0,
		stageBytes: 0,
		screen: tui.captureViewport()?.rows ?? [],
	};
}

async function roomSwitch(
	env: Env,
	room: readonly Conversation[],
	from: Conversation,
	next: Conversation,
): Promise<SwitchSample> {
	const { tui, terminal, scheduler } = env;
	const clock = new MotionClock();
	let clockTime = 0;
	let lands = 0;
	let overlay: OverlayHandle | undefined;
	let stage: RoomStage | undefined;
	const members: RoomStageMember[] = room.map(c => ({
		id: c.id,
		snapshot: () => c.snapshot,
		waitingDialogs: 0,
		origin: c === from,
	}));
	const host: RoomStageHost = {
		requestRender: () => tui.requestRender(),
		rows: () => terminal.rows,
		members: () => members,
		prepare: async () => {
			// The controller's prepare awaits the foreground claim before it swaps the screen.
			await Promise.resolve();
			show(tui, next);
			return tui.composeViewport()?.rows;
		},
		land: () => {
			lands++;
			stage?.dispose();
			overlay?.hide();
			tui.requestRender(true, { clearScrollback: true });
		},
		create: () => Promise.reject(new Error("the room bench never opens a conversation")),
		close: async () => "the room bench never closes a conversation",
		isToggle: () => false,
	};

	const bytes = terminal.bytes;
	const enters = terminal.altEnters;
	const exits = terminal.altExits;
	const start = performance.now();
	stage = new RoomStage(host, {
		originId: from.id,
		originScreen: tui.captureViewport()?.rows,
		layout: "side-by-side",
		mode: { kind: "travel", targetId: next.id },
		clock,
		motion: true,
		now: () => clockTime,
	});
	overlay = tui.showOverlay(stage, ROOM_OVERLAY);
	scheduler.flush();
	let stageFrames = 1;
	while (lands === 0) {
		if (stageFrames > MAX_STAGE_FRAMES)
			benchFail(`${from.id} -> ${next.id}: no land after ${MAX_STAGE_FRAMES} frames`);
		clockTime += FRAME_MS;
		clock.tick(clockTime);
		await drainMicrotasks();
		if (lands > 0) break;
		scheduler.flush();
		stageFrames++;
	}
	const stageBytes = terminal.bytes - bytes;
	scheduler.flush();
	const ms = performance.now() - start;

	// Nothing after the land lands again.
	for (let i = 0; i < 5; i++) {
		clockTime += FRAME_MS;
		clock.tick(clockTime);
		await drainMicrotasks();
	}
	if (lands !== 1) benchFail(`${from.id} -> ${next.id}: landed ${lands} times`);
	if (terminal.altEnters - enters !== 1 || terminal.altExits - exits !== 1) {
		benchFail(
			`${from.id} -> ${next.id}: entered the alternate screen ${terminal.altEnters - enters} times and left it ${terminal.altExits - exits} times`,
		);
	}
	return { ms, bytes: terminal.bytes - bytes, stageFrames, stageBytes, screen: tui.captureViewport()?.rows ?? [] };
}

interface ArmResult {
	readonly samples: readonly SwitchSample[];
}

function row(cells: readonly (string | number)[], widths: readonly number[]): string {
	return cells
		.map((cell, i) => (i < 3 ? String(cell).padEnd(widths[i]!) : String(cell).padStart(widths[i]!)))
		.join("  ");
}

await initTheme();

console.log(
	`\nBenchmark: room-view (switch between two conversations, ${SWITCHES} switches per row after ${WARMUP} untimed)\n`,
);
const WIDTHS = [7, 6, 22, 9, 8, 8, 13, 7, 12] as const;
console.log(
	row(["grid", "blocks", "arm", "mean ms", "p50 ms", "p95 ms", "bytes/switch", "frames", "bytes/frame"], WIDTHS),
);

for (const grid of GRIDS) {
	for (const blocks of CORPORA) {
		const room = [conversation("a", blocks, 0), conversation("b", blocks, 10_000)];
		const results = new Map<string, ArmResult>();
		const offScreens = new Map<string, readonly string[]>();

		for (const arm of ["off", "on"] as const) {
			const env = makeEnv(grid, room[0]!);
			const samples: SwitchSample[] = [];
			let current = room[0]!;
			for (let i = 0; i < WARMUP + SWITCHES; i++) {
				const next = current === room[0] ? room[1]! : room[0]!;
				const sample = arm === "off" ? plainSwitch(env, next) : await roomSwitch(env, room, current, next);
				if (arm === "off") {
					offScreens.set(next.id, sample.screen);
					if (env.terminal.altEnters !== 0)
						benchFail(`off arm entered the alternate screen ${env.terminal.altEnters} times`);
				} else {
					const expected = offScreens.get(next.id);
					if (!expected || expected.join("\n") !== sample.screen.join("\n")) {
						benchFail(
							`${grid.columns}x${grid.rows} ${blocks} blocks: the room landed on a screen the plain switch does not paint`,
						);
					}
				}
				if (sample.screen.length !== grid.rows)
					benchFail(`${arm} arm: the committed screen is ${sample.screen.length} rows`);
				if (i >= WARMUP) samples.push(sample);
				current = next;
			}
			env.tui.stop();
			results.set(arm, { samples });
		}

		for (const [arm, { samples }] of results) {
			const stats = benchStats(samples.map(s => s.ms));
			const bytes = samples.reduce((sum, s) => sum + s.bytes, 0) / samples.length;
			const frames = samples.reduce((sum, s) => sum + s.stageFrames, 0) / samples.length;
			const stageBytes = samples.reduce((sum, s) => sum + s.stageBytes, 0) / samples.length;
			console.log(
				row(
					[
						`${grid.columns}x${grid.rows}`,
						blocks,
						arm === "off" ? "off: plain switch" : "on:  room quick switch",
						stats.mean.toFixed(3),
						stats.p50.toFixed(3),
						stats.p95.toFixed(3),
						Math.round(bytes),
						frames.toFixed(1),
						frames > 0 ? Math.round(stageBytes / frames) : "-",
					],
					WIDTHS,
				),
			);
		}
	}
}
console.log(
	`\nThe on arm's frames play over ${MOTION.expand.duration + MOTION.travel.duration}ms of wall time at 60Hz; the ms columns are the compute those frames cost.`,
);
