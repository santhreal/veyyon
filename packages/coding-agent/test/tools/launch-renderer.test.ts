/**
 * Launch renderer contract: one merged status header per op carrying the op,
 * target name, and daemon state — replacing the old stacked "pending header +
 * bare `✓ Launch` + raw text" render — plus per-op body rules (logs strip the
 * LLM-facing `[name: state; cursor=N]` suffix, list caps collapsed rows).
 */
import { describe, expect, it } from "bun:test";
import type { DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { renderTerminalOutput } from "@veyyon/coding-agent/launch/terminal-output";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { type LaunchToolDetails, launchToolRenderer } from "@veyyon/coding-agent/tools/launch";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { sanitizeText } from "@veyyon/utils";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");

const daemon = (overrides: Partial<DaemonSnapshot>): DaemonSnapshot => ({
	name: "web",
	id: "d-1",
	state: "running",
	pid: 51234,
	createdAt: 0,
	startedAt: Date.now() - 22_600,
	restartCount: 0,
	outputBytes: 0,
	persist: false,
	detached: false,
	...overrides,
});

describe("launchToolRenderer", () => {
	it("is registered with merged call/result so the pending header is replaced, not stacked", () => {
		expect(Object.is(toolRenderers.launch.renderResult, launchToolRenderer.renderResult)).toBe(true);
		expect(toolRenderers.launch.mergeCallAndResult).toBe(true);
	});

	it("folds a stop result into one header with op, name, and exit state", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			launchToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Stopped pyc-profile-run: exited exit=0 uptime=22.6s restarts=0" }],
					details: {
						op: "stop",
						daemon: daemon({ name: "pyc-profile-run", state: "exited", exitedAt: Date.now(), exitCode: 0 }),
					} satisfies LaunchToolDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "stop", name: "pyc-profile-run" },
			),
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("Launch stop");
		expect(rendered[0]).toContain("pyc-profile-run");
		expect(rendered[0]).toContain("exited");
		expect(rendered[0]).toContain("exit 0");
	});

	it("renders log lines without the trailing cursor-status suffix, surfacing it as header meta", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			launchToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "line one\nline two\n[web: running; cursor=2210]" }],
					details: { op: "logs", cursor: 2210, timedOut: false, state: "running" } satisfies LaunchToolDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "logs", name: "web" },
			),
		);
		expect(rendered[0]).toContain("Launch logs");
		expect(rendered[0]).toContain("cursor 2210");
		expect(rendered[0]).toContain("┌");
		expect(rendered[1]).toContain("Output");
		expect(rendered.at(-1)).toContain("└");

		// The log body, in order and complete. Two `some(...)` checks asserted the
		// lines existed somewhere and a third asserted the `[web: running; ...]`
		// suffix did not, none of which could tell whether the tail was rendered in
		// order, which is the one thing a log tail has to get right. Reading the
		// body out as an array proves the ordering and the suffix stripping at
		// once: a line that survived would have to appear here.
		const body = rendered
			.filter(line => line.startsWith("│"))
			.map(line => line.replace(/^│\s?/, "").replace(/\s*│$/, "").trimEnd());

		expect(body).toEqual(["line one", "line two"]);
	});

	it("replays terminal screen rows so cursor rewrites retain their final color and weight", async () => {
		const terminalRows = await renderTerminalOutput(
			"\x1b[1;31mold\x1b[0m\r\x1b[2K\x1b[12G\x1b[1;32mready\x1b[0m\x1b[K",
			{
				head: false,
				maxRows: 10,
			},
		);
		if (terminalRows === undefined) throw new Error("terminal replay failed");
		expect(Bun.stripANSI(terminalRows[0] ?? "")).toBe("           ready");

		const uiTheme = await theme();
		const component = launchToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "ready\n[web: running; cursor=2210]" }],
				details: {
					op: "logs",
					cursor: 2210,
					timedOut: false,
					state: "running",
					terminalRows,
				} satisfies LaunchToolDetails,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ op: "logs", name: "web" },
		);
		const raw = component.render(200).join("\n");
		const plain = Bun.stripANSI(raw);
		expect(plain).toContain("ready");
		expect(plain).not.toContain("old");
		expect(raw).toContain("\x1b[1;38;5;2mready");
	});

	it("caps a collapsed list to the preview item limit with a more-items row", async () => {
		const uiTheme = await theme();
		const daemons = Array.from({ length: 11 }, (_, i) => daemon({ name: `svc-${i}`, id: `d-${i}` }));
		const rendered = lines(
			launchToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { op: "list", daemons } satisfies LaunchToolDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "list" },
			),
		);
		expect(rendered[0]).toContain("11 processes");

		// Which eight survived the cap, in which order, and that the notice is the
		// last row. The three checks that stood here said only that svc-0 appeared,
		// svc-10 did not, and the words "3 more processes" were present somewhere:
		// a renderer that kept svc-3 through svc-10 and dropped the first three
		// satisfied every one of them, and so did one that put the more-row first.
		// Each row's uptime is derived from the clock, so the row IDENTITY is read
		// out rather than the whole line.
		const rows = rendered.slice(1).map(line => line.split(" ")[0]);

		expect(rows).toEqual(["svc-0", "svc-1", "svc-2", "svc-3", "svc-4", "svc-5", "svc-6", "svc-7", "…"]);
		expect(rendered.at(-1)).toContain("3 more processes");
	});

	it("marks a failed start with the daemon's exit reason even though the result is not an error", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			launchToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Failed to launch web: failed exit=127" }],
					details: {
						op: "start",
						daemon: daemon({
							state: "failed",
							exitedAt: Date.now(),
							exitCode: 127,
							exitReason: "spawn bun ENOENT",
						}),
					} satisfies LaunchToolDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "start", name: "web", application: "bun", args: ["run", "dev"] },
			),
		);
		expect(rendered[0]).toContain("Launch start");
		expect(rendered[0]).toContain("failed");
		expect(rendered.some(line => line.includes("spawn bun ENOENT"))).toBe(true);
	});

	it("names the unmet readiness condition instead of a contradictory Ready + timed-out pair", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			launchToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "start",
						timedOut: true,
						daemon: daemon({
							state: "starting",
							readyMatch: "Local: http://localhost:3100",
							readyPending: ["port"],
						}),
					} satisfies LaunchToolDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "start", name: "web", application: "bunx", args: ["vite"], ready: { log: "Local:", port: 3100 } },
			),
		);
		expect(rendered[0]).toContain("waiting on port");
		expect(rendered.some(line => line.includes("log matched: Local: http://localhost:3100"))).toBe(true);
		expect(rendered.some(line => line.includes("port 3100 on 127.0.0.1 never accepted connections"))).toBe(true);
		// The old render labeled the log match a bare "ready:" while also saying readiness timed out.
		expect(rendered.some(line => line.includes("ready: Local:"))).toBe(false);
	});
});
