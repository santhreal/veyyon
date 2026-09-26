/**
 * Streaming tool-card draw benchmark.
 *
 * Streams the arguments of a `write` or `bash` call into a `ToolExecutionComponent` the way the event
 * controller does, a fixed number of characters per delta, and times each `updateArgs` plus
 * `render(120)`. The source is the same generated TypeScript on every run, so two runs differ only in
 * the drawing code.
 *
 * Metric (lower is better): `total` is the wall clock of the whole stream, and `last10%` the mean of
 * the last tenth of the frames, which is where a draw that re-does the whole source on every delta
 * spends its time: its frame cost grows with the file and the stream's total with its square.
 *
 * Run: bun packages/coding-agent/bench/streaming-tool-card.bench.ts
 */

import type { TUI } from "@veyyon/tui";
import { ToolExecutionComponent } from "../src/modes/terminal/components/transcript/tool-execution";
import { initTheme } from "../src/theme/theme";

/** Each stream: the tool, the lines of source it carries, and the characters each delta adds. */
const CASES: ReadonlyArray<{ tool: "write" | "bash"; lines: number; chunk: number }> = [
	{ tool: "write", lines: 200, chunk: 24 },
	{ tool: "write", lines: 600, chunk: 48 },
	{ tool: "write", lines: 1500, chunk: 48 },
	{ tool: "bash", lines: 100, chunk: 24 },
];

function source(lines: number): string {
	return Array.from(
		{ length: lines },
		(_, index) =>
			`\tconst value${index} = compute(${index}, "item ${index}"); // ${"step ".repeat(index % 5)}${index}`,
	).join("\n");
}

function argsAt(tool: "write" | "bash", text: string): Record<string, unknown> {
	return tool === "write" ? { path: "src/generated/values.ts", content: text } : { command: text };
}

const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

await initTheme(false);

for (const { tool, lines, chunk } of CASES) {
	const body = source(lines);
	const component = new ToolExecutionComponent(tool, argsAt(tool, ""), {}, undefined, ui);
	const frames: number[] = [];
	const start = performance.now();
	for (let end = chunk; end <= body.length + chunk; end += chunk) {
		const frameStart = performance.now();
		component.updateArgs(argsAt(tool, body.slice(0, end)));
		component.render(120);
		frames.push(performance.now() - frameStart);
	}
	const total = performance.now() - start;
	component.stopAnimation();
	const lastTenth = frames.slice(-Math.max(1, Math.floor(frames.length / 10)));
	const lastMean = lastTenth.reduce((sum, frame) => sum + frame, 0) / lastTenth.length;
	console.log(
		`${tool} lines=${lines} chars=${body.length} frames=${frames.length} total=${total.toFixed(0)}ms last10%=${lastMean.toFixed(3)}ms`,
	);
}
