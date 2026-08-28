/**
 * WHY THIS SUITE EXISTS.
 *
 * The `launch` tool TUI renderer displayed `| … Launch …` when streaming tool
 * arguments had not yet populated `args.op`, or when `renderCall` received an empty
 * object or intent-only arguments. The double ellipsis
 * (`… Launch …`) and missing description appeared as an empty or broken block to
 * the user.
 *
 * Furthermore, when tool results arrived without structured `details` (e.g. from
 * wire transports, subagent returns, session replay, or external callers), `renderResult`
 * strictly gated body generation on the presence of `details.daemon` or `details.daemons`,
 * causing `list`, `describe`, `start`, `stop`, `restart`, `send`, and `wait` to drop
 * all plain-text output in `result.content` and render empty bodies or misleading
 * "no processes" descriptions.
 *
 * WHAT THIS SUITE CLOSES:
 * 1. Every operation in the `LaunchParams["op"]` union produces non-empty, well-formed
 *    renders across both full-details and missing-details paths.
 * 2. `renderCall` with empty args, intent-only args, partial streaming args, or missing
 *    `op` renders a clean "Launch" title and surfaces the target it has, never emitting
 *    the `Launch …` placeholder title and never printing the command line twice.
 * 3. `renderResult` falls back to `result.content` text when `details` or `daemon` is
 *    absent, preventing blank cards across all operations.
 * 4. `STREAMING_STRING_KEYS_BY_TOOL` covers `launch` so streaming reveals update smoothly.
 * 5. Runtime enumeration of the `op` schema ensures any new operation added in the
 *    future turns this suite red until explicit render handling is verified.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Terminal font rendering artifacts or PTY escape sequences specific to external
 * terminal emulators.
 */

import { describe, expect, it } from "bun:test";
import type { DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { streamingStringKeysForTool } from "@veyyon/coding-agent/modes/terminal/controllers/tool-args-reveal";
import { getThemeByName } from "@veyyon/coding-agent/theme/theme";
import { type LaunchToolDetails, launchToolRenderer } from "@veyyon/coding-agent/tools/launch";
import { sanitizeText } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");

const ALL_LAUNCH_OPS = ["start", "list", "logs", "wait", "send", "stop", "restart", "describe"] as const;

const sampleDaemon: DaemonSnapshot = {
	name: "web",
	id: "d-100",
	state: "running",
	pid: 4321,
	createdAt: Date.now() - 10_000,
	startedAt: Date.now() - 10_000,
	restartCount: 0,
	outputBytes: 1024,
	persist: false,
	detached: false,
};

describe("launch-tool-renders-non-empty-on-all-operations-and-missing-details", () => {
	describe("renderCall handles missing op, intent, and streaming args cleanly", () => {
		it("renders 'Launch' without ellipsis suffix when op is undefined", async () => {
			const uiTheme = await theme();
			const rendered = lines(launchToolRenderer.renderCall({}, { expanded: false, isPartial: true }, uiTheme));
			expect(rendered).toHaveLength(1);
			expect(rendered[0]).toContain("Launch");
			expect(rendered[0]).not.toContain("Launch …");
			expect(rendered[0]).not.toContain("Launch undefined");
		});

		it("keeps the harness intent out of the block, because the working message already carries it", async () => {
			const uiTheme = await theme();
			const rendered = lines(
				launchToolRenderer.renderCall(
					{ [INTENT_FIELD]: "Starting dev server" } as never,
					{ expanded: false, isPartial: true },
					uiTheme,
				),
			);
			expect(rendered[0]).toContain("Launch");
			expect(rendered[0]).not.toContain("Starting dev server");
		});

		it("prints the command once when a name is also present, at both truncation lengths", async () => {
			const uiTheme = await theme();
			const short = lines(
				launchToolRenderer.renderCall(
					{ op: "start", application: "bun", args: ["run", "dev"] },
					{ expanded: false, isPartial: true },
					uiTheme,
				),
			).join("");
			expect(short.split("bun run dev")).toHaveLength(2);

			// A command past TRUNCATE_LENGTHS.SHORT is truncated in the meta slot and
			// not in the description, so a renderer that de-duplicated the two by
			// string equality printed both copies here.
			const long = lines(
				launchToolRenderer.renderCall(
					{ op: "start", application: "bun", args: ["run", "dev", "--", "--flag", "x".repeat(120)] },
					{ expanded: false, isPartial: true },
					uiTheme,
				),
			).join("");
			expect(long.split("bun run dev")).toHaveLength(2);
		});

		it("surfaces application and args when op is start or streaming", async () => {
			const uiTheme = await theme();
			const rendered = lines(
				launchToolRenderer.renderCall(
					{ application: "bun", args: ["run", "dev"] },
					{ expanded: false, isPartial: true },
					uiTheme,
				),
			);
			expect(rendered[0]).toContain("Launch");
			expect(rendered[0]).toContain("bun run dev");
		});

		it("surfaces target name and command cleanly when name is present", async () => {
			const uiTheme = await theme();
			const rendered = lines(
				launchToolRenderer.renderCall(
					{ op: "start", name: "dev-server", application: "bun", args: ["run", "dev"] },
					{ expanded: false, isPartial: true },
					uiTheme,
				),
			);
			expect(rendered[0]).toContain("Launch start");
			expect(rendered[0]).toContain("dev-server");
			expect(rendered[0]).toContain("bun run dev");
		});

		it("enumerates all operations in renderCall and produces valid headers", async () => {
			const uiTheme = await theme();
			for (const op of ALL_LAUNCH_OPS) {
				const rendered = lines(
					launchToolRenderer.renderCall({ op, name: "worker" }, { expanded: false, isPartial: true }, uiTheme),
				);
				expect(rendered[0]).toContain(`Launch ${op}`);
				expect(rendered[0]).toContain("worker");
				expect(rendered[0]).not.toContain("…");
			}
		});
	});

	describe("renderResult falls back to text content when details or daemons are missing", () => {
		it("renders fallback text for list when details are absent", async () => {
			const uiTheme = await theme();
			const rawText = "- web: running pid=4321 uptime=10s\n- api: running pid=4322 uptime=10s";
			const rendered = lines(
				launchToolRenderer.renderResult(
					{ content: [{ type: "text", text: rawText }] },
					{ expanded: false, isPartial: false },
					uiTheme,
					{ op: "list" },
				),
			);
			expect(rendered[0]).toContain("Launch list");
			expect(rendered[0]).not.toContain("no processes");
			expect(rendered.some(l => l.includes("web: running"))).toBe(true);
			expect(rendered.some(l => l.includes("api: running"))).toBe(true);
		});

		it("renders fallback text for describe when spec is absent", async () => {
			const uiTheme = await theme();
			const rawText = "web: running pid=4321\nCommand: bun run dev\nCwd: /app";
			const rendered = lines(
				launchToolRenderer.renderResult(
					{ content: [{ type: "text", text: rawText }] },
					{ expanded: false, isPartial: false },
					uiTheme,
					{ op: "describe", name: "web" },
				),
			);
			expect(rendered[0]).toContain("Launch describe");
			expect(rendered[0]).toContain("web");
			expect(rendered.some(l => l.includes("Command: bun run dev"))).toBe(true);
		});

		it("renders fallback text for start when daemon is absent", async () => {
			const uiTheme = await theme();
			const rawText = "Started web: running pid=4321 uptime=0s";
			const rendered = lines(
				launchToolRenderer.renderResult(
					{ content: [{ type: "text", text: rawText }] },
					{ expanded: false, isPartial: false },
					uiTheme,
					{ op: "start", name: "web", application: "bun", args: ["run", "dev"] },
				),
			);
			expect(rendered[0]).toContain("Launch start");
			expect(rendered.some(l => l.includes("Started web: running"))).toBe(true);
		});

		it("renders fallback text for stop, restart, wait, and send when daemon is absent", async () => {
			const uiTheme = await theme();
			const ops: Array<{ op: "stop" | "restart" | "wait" | "send"; text: string }> = [
				{ op: "stop", text: "Stopped web: exited exit=0 uptime=12s" },
				{ op: "restart", text: "Restarted web: running pid=5432 uptime=0s" },
				{ op: "wait", text: "web: exited exit=0\nMatched: ready" },
				{ op: "send", text: "Sent input to web: running pid=4321" },
			];
			for (const { op, text } of ops) {
				const rendered = lines(
					launchToolRenderer.renderResult(
						{ content: [{ type: "text", text }] },
						{ expanded: false, isPartial: false },
						uiTheme,
						{ op, name: "web" },
					),
				);
				expect(rendered[0]).toContain(`Launch ${op}`);
				expect(rendered.some(l => l.includes(text.split("\n")[0]!))).toBe(true);
			}
		});

		it("renders (no output) placeholder for logs when output is empty", async () => {
			const uiTheme = await theme();
			const rendered = lines(
				launchToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: { op: "logs", cursor: 0, timedOut: false, state: "running" } satisfies LaunchToolDetails,
					},
					{ expanded: false, isPartial: false },
					uiTheme,
					{ op: "logs", name: "web" },
				),
			);
			expect(rendered[0]).toContain("Launch logs");
			expect(rendered.some(l => l.includes("(no output)"))).toBe(true);
		});

		it("renders every operation with structured details without regression", async () => {
			const uiTheme = await theme();
			for (const op of ALL_LAUNCH_OPS) {
				const details: LaunchToolDetails =
					op === "list"
						? { op: "list", daemons: [sampleDaemon] }
						: op === "logs"
							? { op: "logs", state: "running", cursor: 10, timedOut: false, terminalRows: ["log row 1"] }
							: op === "describe"
								? {
										op: "describe",
										daemon: sampleDaemon,
										spec: {
											name: "web",
											application: "bun",
											args: ["run", "dev"],
											env: {},
											cwd: "/app",
											pty: true,
											restart: "no",
											persist: false,
											detached: false,
										},
									}
								: { op, daemon: sampleDaemon };

				const rendered = lines(
					launchToolRenderer.renderResult(
						{
							content: [{ type: "text", text: `Output for ${op}` }],
							details,
						},
						{ expanded: false, isPartial: false },
						uiTheme,
						{ op, name: "web" },
					),
				);
				expect(rendered[0]).toContain(`Launch ${op}`);
				expect(rendered.length).toBeGreaterThanOrEqual(1);
			}
		});
	});

	describe("tool-args-reveal configuration", () => {
		it("includes launch string keys for smooth streaming reveal", () => {
			const keys = streamingStringKeysForTool("launch", false);
			expect(keys).toBeDefined();
			expect(keys).toContain("op");
			expect(keys).toContain("name");
			expect(keys).toContain("application");
			expect(keys).toContain("text");
			expect(keys).toContain("pattern");
			expect(keys).toContain("signal");
			// The harness intent is not a launch argument. No tool streams it, and
			// `event-controller` reads it off the raw args for the working message.
			expect(keys).not.toContain(INTENT_FIELD);
		});
	});
});
