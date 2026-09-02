/**
 * What the bash card states, from the command a call carries to what the shell wrote back.
 *
 * WHY THIS EXISTS. `bashToolView` is the whole of what a bash run says to a reader on any host: the
 * command under its prompt, the program's own rows, and the facts the tool appended to the model's
 * payload as sentences and the card states as its own row (wall time, exit status, the job a run was
 * handed to, the artifact a spilled capture went to). Each of those is a claim a reader acts on, and
 * each was a defect at least once: a notice printed twice, a notice folded away while the fact it
 * carried disappeared with it, an image payload styled into rubble, a home directory leaked through
 * a working-directory preview.
 *
 * THE CLASS THIS CLOSES. A fact that reaches the card through the payload rather than through the
 * details, and a row the card composes from bytes it does not own. The suite drives the view and the
 * terminal's own mapping of it -- `drawToolView` -- so a claim is asserted on the rows a reader
 * sees, not on the shape of an intermediate value.
 *
 * WHAT IT DOES NOT CATCH. Execution: nothing here runs a command, so what a shell prints, which
 * notices `bash.ts` appends and when a run is backgrounded are `bash.ts`'s own suites. That the rows
 * are the SAME BYTES main's renderer drew is
 * `test/differential/the-bash-card-draws-what-main-drew.test.ts`, which compares the two arms; this
 * file states what the card claims, and would stay green if both arms changed together.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { previewWindowRows } from "@veyyon/coding-agent/tools/core/render-utils";
import { BASH_DEFAULT_PREVIEW_LINES } from "@veyyon/coding-agent/tools/shell/bash";
import { type BashViewArgs, type BashViewResult, bashToolView } from "@veyyon/coding-agent/tools/shell/bash-view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { ImageProtocol, TERMINAL } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import type { FramedBlockView, ToolView, ToolViewContext } from "@veyyon/view";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;

const COLLAPSED: ToolViewContext = { expanded: false, partial: false };
const EXPANDED: ToolViewContext = { expanded: true, partial: false };

/** The framed card a bash view states, so a cell may read the sections under it. */
function framed(view: ToolView): FramedBlockView {
	if (view.kind !== "framedBlock") throw new Error(`the bash card is a framed block, not a ${view.kind}`);
	return view;
}

describe("the bash card", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
	});

	/** The rows a host draws for a call, as the words a reader sees. */
	async function callRows(args: BashViewArgs, context: ToolViewContext = COLLAPSED, width = 120): Promise<string[]> {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		return [...drawToolView(bashToolView.renderCall(args, context), theme!).render(width)];
	}

	/** The rows a host draws for a settled result, as the words a reader sees. */
	async function resultRows(
		result: BashViewResult,
		args: BashViewArgs,
		context: ToolViewContext = COLLAPSED,
		width = 120,
	): Promise<string[]> {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		return [...drawToolView(bashToolView.renderResult(result, context, args), theme!).render(width)];
	}

	const text = (lines: readonly string[]): string => sanitizeText(lines.join("\n"));

	it("states env assignments in the command preview as a shell would take them", async () => {
		const rendered = text(
			await callRows({ command: "printf '%s' \"$MERMAID\"", env: { MERMAID: 'line "one"\ntwo' } }),
		);
		expect(rendered).toContain('MERMAID="line \\"one\\"\\ntwo"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("states env assignments while the argument JSON is still arriving", async () => {
		const rendered = text(
			await callRows(
				{
					command: "printf '%s' \"$MERMAID\"",
					__partialJson: '{"command":"printf \'%s\' "$MERMAID"","env":{"MERMAID":"line 1\\nline 2',
				},
				{ expanded: false, partial: true },
			),
		);
		expect(rendered).toContain('MERMAID="line 1\\nline 2"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("replaces command tabs and shortens a home working directory", async () => {
		const rendered = text(
			await callRows({ command: "printf\t'%s'", cwd: path.join(os.homedir(), "projects", "demo") }),
		);
		expect(rendered).toContain("~/projects/demo");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("\t");
	});

	it("draws a pending call as one rail row carrying the command", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const lines = Bun.stripANSI(
			drawToolView(bashToolView.renderCall({ command: "sleep 30" }, { expanded: false, partial: true }), theme!)
				.render(60)
				.join("\n"),
		).split("\n");
		// A pending call hangs on a rail: one row, the rail glyph down its left, the command beside
		// it. There is no header, because a title reading "Bash" over `$ sleep 30` names nothing.
		const rail = theme!.symbol("block.rail");
		expect(lines).toEqual([`${rail}  $ sleep 30 `]);
		expect(lines[0]).not.toContain("Bash");
	});

	it("states the effective timeout from the details over the one the call asked for", async () => {
		const rendered = text(
			await resultRows(
				{ content: [{ type: "text", text: "" }], details: { timeoutSeconds: 120 }, isError: false },
				{ command: "python3 scripts/edit-benchmark.py", timeout: 1200 },
			),
		);
		expect(rendered).toContain("Timeout: 120s");
		expect(rendered).not.toContain("Timeout: 1200s");
	});

	it("states a disabled bound rather than a clamped one", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "still going" }],
					details: { timeoutDisabled: true, wallTimeMs: 4000 },
					isError: false,
				},
				{ command: "tail -f log", timeout: 0 },
			),
		);
		expect(rendered).toContain("Timeout: disabled");
		expect(rendered).not.toContain("Timeout: 1s");
	});

	it("names a clamped bound and what was asked for", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "done" }],
					details: { timeoutSeconds: 3600, requestedTimeoutSeconds: 99_999 },
					isError: false,
				},
				{ command: "sleep 99999" },
			),
		);
		expect(rendered).toContain("Timeout: 3600s (requested 99999s clamped)");
	});

	it("states wall time in its own row and strips the sentence the payload carried", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "hello\n\nWall time: 1.23 seconds" }],
					details: { timeoutSeconds: 5, wallTimeMs: 1230 },
					isError: false,
				},
				{ command: "echo hi" },
			),
		);
		expect(rendered).toContain("Wall: 1.23s");
		expect(rendered).toContain("Timeout: 5s");
		// The styled row is the only place wall time is stated, so a reader never reads it twice.
		expect(rendered).not.toContain("Wall time: 1.23 seconds");
	});

	it("names the job a backgrounded run was handed to and drops the hand-off sentence", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [
						{
							type: "text",
							text: "started\n\nBackgrounded as job bash-42; result will be delivered automatically.",
						},
					],
					details: { timeoutSeconds: 300, async: { state: "running", jobId: "bash-42", type: "bash" } },
					isError: false,
				},
				{ command: "sleep 30" },
			),
		);
		expect(rendered).toContain("started");
		expect(rendered).toContain("Backgrounded: bash-42");
		expect(rendered).not.toContain("result will be delivered automatically");
	});

	it("names the artifact a spilled capture went to and drops its notice", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "filtered\n[raw output: artifact://13]\n\nWall time: 0.08 seconds" }],
					details: { timeoutSeconds: 300, wallTimeMs: 80 },
					isError: false,
				},
				{ command: "bun run check:types" },
			),
		);
		expect(rendered).toContain("filtered");
		expect(rendered).toContain("Wall: 0.08s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).toContain("Artifact: 13");
		expect(rendered).not.toContain("[raw output: artifact://13]");
		expect(rendered).not.toContain("artifact://13");
	});

	it("states the exit status and drops the exit sentence for a failed command", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "boom\n\nWall time: 0.02 seconds\n\nCommand exited with code 1" }],
					details: { timeoutSeconds: 300, wallTimeMs: 20, exitCode: 1 },
					isError: true,
				},
				{ command: "false" },
			),
		);
		expect(rendered).toContain("Wall: 0.02s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).toContain("Exit: 1");
		// Both sentences fold into the card's own row rather than being echoed in the output region.
		expect(rendered).not.toContain("Command exited with code 1");
		expect(rendered).not.toContain("Wall time: 0.02 seconds");
		// The command's own output still shows.
		expect(rendered).toContain("boom");
	});

	it("names the signal that killed a run beside the code it exited with", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "killed" }],
					details: { exitCode: 137, signal: 9, wallTimeMs: 50 },
					isError: true,
				},
				{ command: "./hog" },
			),
		);
		expect(rendered).toContain("Exit: 137 (SIGKILL)");
	});

	it("heads a failed run with the word, so the outcome survives with no colour at all", async () => {
		const failed = await resultRows(
			{ content: [{ type: "text", text: "boom" }], details: { exitCode: 1 }, isError: true },
			{ command: "false" },
		);
		const clean = await resultRows(
			{ content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false },
			{ command: "true" },
		);
		expect(text(failed)).toContain("failed");
		// The one thing a monochrome terminal, a colour-blind reader and a copied transcript keep.
		expect(Bun.stripANSI(failed.join("\n"))).toContain("failed");
		expect(text(clean)).not.toContain("failed");
	});

	it("states no exit row for a successful command", async () => {
		const rendered = text(
			await resultRows(
				{
					content: [{ type: "text", text: "ok\n\nWall time: 0.02 seconds" }],
					details: { timeoutSeconds: 300, wallTimeMs: 20 },
					isError: false,
				},
				{ command: "true" },
			),
		);
		expect(rendered).toContain("Wall: 0.02s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).not.toContain("Exit:");
	});

	it("leaves an image payload untouched and asks for no window around it", async () => {
		// A payload only survives sanitation when the operator turned passthrough on, which is the same
		// pair of switches the terminal host reads before it hands a capture to the card. Without them
		// the escape is stripped upstream and the row is text, which is the case every other cell here
		// runs under.
		const originalForce = process.env.VEYYON_FORCE_IMAGE_PROTOCOL;
		const originalAllow = process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH;
		process.env.VEYYON_FORCE_IMAGE_PROTOCOL = "sixel";
		process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH = "1";
		terminal.imageProtocol = ImageProtocol.Sixel;
		const sixel = "\x1bPqabc\x1b\\";
		try {
			const lines = await resultRows(
				{ content: [{ type: "text", text: `line one\n${sixel}\nline two` }], details: {}, isError: false },
				{ command: "echo sixel" },
				COLLAPSED,
				80,
			);
			// The bytes are the program's: an image protocol is a control sequence, and a colour opened
			// around it — or a rail drawn before it — would be written into the middle of the image.
			expect(lines.filter(line => line === sixel)).toHaveLength(1);
			expect(lines.some(line => line.includes("earlier line"))).toBe(false);
		} finally {
			if (originalForce === undefined) delete process.env.VEYYON_FORCE_IMAGE_PROTOCOL;
			else process.env.VEYYON_FORCE_IMAGE_PROTOCOL = originalForce;
			if (originalAllow === undefined) delete process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH;
			else process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH = originalAllow;
		}
	});

	it("carries its own styling run on every line of a multi-line command", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		setThemeInstance(uiTheme!);
		const command = 'for f in a b; do\n\techo "$f"\ndone';
		const rendered = await resultRows(
			{ content: [{ type: "text", text: "" }], details: {}, isError: false },
			{ command },
		);
		const sanitized = rendered.map(line => sanitizeText(line));
		const findLine = (needle: string): number => sanitized.findIndex(line => line.includes(needle));
		const forLine = findLine("for f in a b; do");
		const echoLine = findLine('echo "$f"');
		const doneLine = findLine("done");
		expect(forLine).toBeGreaterThanOrEqual(0);
		expect(echoLine).toBeGreaterThanOrEqual(0);
		expect(doneLine).toBeGreaterThanOrEqual(0);
		// Each command line carries its own SGR run, because a terminal resets styling at a newline.
		for (const index of [forLine, echoLine, doneLine]) {
			expect(rendered[index]).toMatch(/\u001b\[38;(?:2|5);/);
		}
	});

	it("names the language a host highlights the command in", async () => {
		// A terminal highlights the run itself; an editor host hands the section to its own tokenizer
		// and a transcript export writes a fenced block naming this. It is the one part of the card a
		// host cannot infer from the rows.
		const view = bashToolView.renderCall({ command: "ls -la" }, COLLAPSED);
		expect(framed(view).sections[0]?.code?.language).toBe("bash");
		expect(framed(view).sections[0]?.code?.lead).toBe("$ ");
	});

	it("hands a host the command with no tab left in it", async () => {
		// A host that is not a terminal lays the section out itself, so the substitution has to be in
		// the rows the view states rather than in the terminal's drawing of them.
		const view = bashToolView.renderCall({ command: "printf\t'%s'" }, COLLAPSED);
		const rows = framed(view).sections[0]?.lines.map(line => line.map(span => span.text).join("")) ?? [];
		expect(rows.join("\n")).toContain("printf ");
		expect(rows.join("\n")).not.toContain("\t");
	});

	it("leaves the row an image payload arrived on untoned and asks for no window", async () => {
		// A tone opens a colour in the middle of the payload and a window cuts it in half. Both are
		// decisions the view states, and a host that draws the capture itself reads them here rather
		// than from the terminal's rows.
		const originalForce = process.env.VEYYON_FORCE_IMAGE_PROTOCOL;
		const originalAllow = process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH;
		process.env.VEYYON_FORCE_IMAGE_PROTOCOL = "sixel";
		process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH = "1";
		terminal.imageProtocol = ImageProtocol.Sixel;
		const sixel = "\x1bPqabc\x1b\\";
		try {
			const view = bashToolView.renderResult(
				{ content: [{ type: "text", text: `line one\n${sixel}\nline two` }], details: {}, isError: false },
				COLLAPSED,
				{ command: "echo sixel" },
			);
			const output = framed(view).sections.find(section => section.label === "Output");
			expect(output).toBeDefined();
			const payload = output?.lines.find(line => line.some(span => span.text === sixel));
			expect(payload).toBeDefined();
			expect(payload?.every(span => span.tone === undefined)).toBe(true);
			// Every other row of the same output is the program's text and is toned.
			expect(output?.lines.some(line => line.some(span => span.tone === "output"))).toBe(true);
			expect(output?.tail).toBeUndefined();
		} finally {
			if (originalForce === undefined) delete process.env.VEYYON_FORCE_IMAGE_PROTOCOL;
			else process.env.VEYYON_FORCE_IMAGE_PROTOCOL = originalForce;
			if (originalAllow === undefined) delete process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH;
			else process.env.VEYYON_ALLOW_SIXEL_PASSTHROUGH = originalAllow;
		}
	});

	it("states the env the call parsed over the buffer it is still arriving on", async () => {
		// The streamed buffer is read so an assignment shows before the JSON object closes, and the
		// parsed object is authoritative the moment it exists: a value the stream caught mid-write
		// would otherwise outlive the value the call actually carries.
		const rendered = text(
			await callRows(
				{
					command: "./run",
					env: { TOKEN: "final" },
					__partialJson: '{"env":{"TOKEN":"fin","LEVEL":"2"},"command":"./run"}',
				},
				{ expanded: false, partial: true },
			),
		);
		expect(rendered).toContain('TOKEN="final"');
		expect(rendered).not.toContain('TOKEN="fin"');
		// A key only the buffer has still shows, which is the reason the buffer is read at all.
		expect(rendered).toContain('LEVEL="2"');
	});

	it("states no command rows for a card rebuilt with no arguments at all", async () => {
		// A transcript rebuilt from a session that kept the result and not the call. A prompt over a
		// command nobody has is a row that says nothing, so the card opens on its output.
		const rendered = text(
			await resultRows(
				{ content: [{ type: "text", text: "output survived" }], details: { wallTimeMs: 10 }, isError: false },
				undefined as unknown as BashViewArgs,
			),
		);
		expect(rendered).toContain("output survived");
		expect(rendered).not.toContain("$ …");
		expect(rendered).not.toContain("…\n");
	});

	it("states no failure header while the output is still arriving", async () => {
		// An error result that is still partial is a run that has not ended: heading it "failed" would
		// call the outcome before the last bytes, and the settled card is what states it.
		const arriving = await resultRows(
			{ content: [{ type: "text", text: "boom" }], details: { exitCode: 1 }, isError: true },
			{ command: "false" },
			{ expanded: false, partial: true },
		);
		expect(text(arriving)).not.toContain("failed");
		const settled = await resultRows(
			{ content: [{ type: "text", text: "boom" }], details: { exitCode: 1 }, isError: true },
			{ command: "false" },
		);
		expect(text(settled)).toContain("failed");
	});

	it("measures the collapsed window in the rows the output occupies, not the lines it has", async () => {
		// Every line here is wider than the card, so each one costs two rows. A window counted in
		// lines would draw twice its bound and push the rows above it off the screen.
		const width = 60;
		const line = "x".repeat(width + 20);
		const output = Array.from({ length: 12 }, (_, i) => `${i}: ${line}`).join("\n");
		const rendered = await resultRows(
			{ content: [{ type: "text", text: output }], details: { wallTimeMs: 10 }, isError: false },
			{ command: "cat wide.txt" },
			COLLAPSED,
			width,
		);
		const bodyRows = rendered.filter(row => /\bx{5}/.test(row));
		expect(bodyRows.length).toBeGreaterThan(0);
		// The bound is a row count, and each of these lines costs two of them, so a window counted in
		// lines would draw twice this.
		expect(bodyRows.length).toBeLessThanOrEqual(Math.min(BASH_DEFAULT_PREVIEW_LINES, previewWindowRows()));
		// The newest line is the one kept, and it is kept whole.
		expect(sanitizeText(rendered.join("\n"))).toContain("11: ");
	});

	it("shrinks the collapsed window to a short terminal rather than to its own bound", async () => {
		// The bound is a ceiling, not the window: a 24-row terminal leaves fewer rows than the card's
		// own limit, and a window that ignored the viewport would draw ten rows into six and strand
		// the command above it off the top of the screen.
		const stdout = process.stdout as { rows?: number };
		const originalRows = stdout.rows;
		stdout.rows = 24;
		try {
			const rows = previewWindowRows();
			expect(rows).toBeLessThan(BASH_DEFAULT_PREVIEW_LINES);
			const width = 60;
			const line = "x".repeat(width + 20);
			const output = Array.from({ length: 12 }, (_, i) => `${i}: ${line}`).join("\n");
			const rendered = await resultRows(
				{ content: [{ type: "text", text: output }], details: { wallTimeMs: 10 }, isError: false },
				{ command: "cat wide.txt" },
				COLLAPSED,
				width,
			);
			// The window is the note plus the rows it kept, and the stats row sits under it: what the
			// output occupies is everything between them, which is the viewport's height less the note.
			const plain = rendered.map(row => sanitizeText(row));
			const note = plain.findIndex(row => row.includes("earlier line"));
			const stats = plain.findIndex(row => row.includes("Wall:"));
			expect(note).toBeGreaterThan(0);
			expect(stats).toBeGreaterThan(note);
			expect(stats - note - 1).toBe(rows - 1);
		} finally {
			if (originalRows === undefined) delete stdout.rows;
			else stdout.rows = originalRows;
		}
	});

	it("re-uses its rows across repeated renders at one width (issue #2081)", async () => {
		// The card is drawn once per repaint; with a long transcript and a 50KB tail that is the hot
		// path that pinned the main thread. The block behind the card keys its cache on the rows and
		// the width, so an unchanged card at an unchanged width does no string work at all.
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const output = Array.from({ length: 200 }, (_, i) => `line ${i}: payload ${"x".repeat(20)}`).join("\n");
		const component = drawToolView(
			bashToolView.renderResult(
				{
					content: [{ type: "text", text: output }],
					details: { timeoutSeconds: 5, wallTimeMs: 12 },
					isError: false,
				},
				COLLAPSED,
				{ command: "printf '%s' big" },
			),
			theme!,
		);

		const first = component.render(120);
		expect(component.render(120)).toBe(first);

		// A width change busts the cache; the rows are rebuilt.
		const wider = component.render(160);
		expect(wider).not.toBe(first);

		// The slot holds the most recent width, so the original width is rebuilt rather than served.
		const sameAgain = component.render(120);
		expect(sameAgain).not.toBe(first);
		expect(sameAgain).not.toBe(wider);
		expect(component.render(120)).toBe(sameAgain);

		component.invalidate?.();
		expect(component.render(120)).not.toBe(sameAgain);
	});

	it("windows a long command to the same rows while it streams and once it lands", async () => {
		// The collapsed command is a tail window: the end of it -- the live edge while arguments
		// arrive -- stays visible behind a row naming what came before. Snapping the whole command
		// open on completion would make the card jump, so only ctrl+o uncaps it.
		const total = previewWindowRows() + 5;
		const command = Array.from({ length: total }, (_, i) => `echo step_${i}`).join("\n");
		const result: BashViewResult = { content: [{ type: "text", text: "" }], details: {}, isError: false };

		for (const context of [{ expanded: false, partial: true }, COLLAPSED] as const) {
			const rendered = text(await resultRows(result, { command }, context));
			expect(rendered).toContain(`echo step_${total - 1}`);
			expect(rendered).toContain("earlier line");
			expect(rendered).not.toContain("echo step_0");
		}

		const expanded = text(await resultRows(result, { command }, EXPANDED));
		expect(expanded).toContain("echo step_0");
		expect(expanded).not.toContain("earlier line");
	});
});
