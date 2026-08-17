/**
 * Drive the REAL engine in the REAL terminal through the shape that strobes.
 *
 * The defect this exists to show is not visible in a screenshot: it is a
 * classification the engine takes every frame, and what reaches the terminal is
 * an ED3 (erase native scrollback) followed by a replay of the whole
 * transcript. So this drives the shipped components — `TUI`, the virtualized
 * `TranscriptContainer`, a pinned footer — at the shape that provokes it: a
 * long session, and pinned chrome (a todo/subagent HUD plus the footer) taller
 * than the viewport, while an answer streams a row at a time.
 *
 * Run it inside a real terminal and count the bytes:
 *
 *     script -q -c "stty rows 24 cols 100; bun scripts/demos/drive-tall-hud.ts" /tmp/out.raw
 *
 * `\x1b[3J` in that capture is the flash. A run with the fix writes none.
 *
 * It takes no model and no network: every row is a literal, so two checkouts
 * can be compared byte for byte.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { TranscriptContainer } from "../../packages/coding-agent/src/modes/components/transcript-container";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "../../packages/tui/src/index";
import { ProcessTerminal } from "../../packages/tui/src/terminal";
import { flag } from "./render-args";

const turns = Number(flag("turns", "40"));
const hudRows = Number(flag("hud", "22"));
const streamFrames = Number(flag("frames", "40"));
const frameMs = Number(flag("frame-ms", "60"));
const headerRows = Number(flag("header", "2"));
const holdMs = Number(flag("hold-ms", "120"));

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/** The answer still arriving: one more row every frame, never finalized. */
class LiveBlock implements Component {
	#rows: string[] = ["  reply: still arriving"];
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  row ${this.#rows.length} of the answer`];
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return [...this.#rows];
	}
}

/** The todo list / subagent roster: chrome that changes height mid-turn. */
class Hud implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	setRows(rows: number): void {
		this.#rows = rows;
	}
	render(): string[] {
		return Array.from({ length: this.#rows }, (_, row) => `  [ ] task ${row + 1}`);
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

class StatusRow implements Component {
	constructor(private readonly text: string) {}
	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
}

await initTheme(false, "unicode", false, "titanium", "titanium");

const terminal = new ProcessTerminal();
const tui = new TUI(terminal, true);

const transcript = new TranscriptContainer();
// `home-anchor-layout` always mounts a filler above the transcript once a
// conversation exists, and the HUDs hang in that same band, so a driver without
// one is not driving the shipped layout.
if (headerRows > 0) {
	tui.addChild(new Block(Array.from({ length: headerRows }, (_, row) => `  header ${row}`)));
}
tui.addChild(transcript);
const hud = new Hud(hudRows);
tui.addChild(hud);
tui.addChild(new StatusRow("  esc to interrupt"));
tui.addChild(new Composer());
tui.setPinnedFooterChildCount(2);
tui.start();

for (let turn = 0; turn < turns; turn++) {
	transcript.addChild(
		new Block([
			`> turn ${turn}: what changed?`,
			"",
			`  reply ${turn}: the engine committed these rows and the transcript dropped them.`,
			"",
		]),
	);
	tui.requestRender();
	await sleep(4);
}

const live = new LiveBlock();
transcript.addChild(live);
for (let frame = 0; frame < streamFrames; frame++) {
	live.grow();
	// The HUD collapses and comes back the way a todo list does when a task
	// finishes and the next one opens.
	if (frame % 7 === 6) hud.setRows(frame % 14 === 6 ? 0 : hudRows);
	tui.requestRender();
	await sleep(frameMs);
}
// Hold the finished screen so a recorder can shoot it and walk the scrollback;
// the process owns the terminal, and exiting closes the window under the camera.
await sleep(holdMs);
tui.stop();
