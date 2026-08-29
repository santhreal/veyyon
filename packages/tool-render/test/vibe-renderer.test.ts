import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of the worker-session tools.
 *
 * WHY THIS SUITE EXISTS. The five `vibe_*` tools had a terminal renderer and no
 * host-agnostic one, so every non-terminal host drew the raw `details` dump.
 * The dump is worst at the three questions a reader actually has, and each one
 * is a pair that looks nearly identical in JSON:
 *
 * - A `send` that STEERED reached a worker mid-turn; one that QUEUED did not,
 *   and the sender should not expect an answer to this turn.
 * - A `wait` that TIMED OUT did not observe what it was waiting for.
 * - A worker that FINISHED the turn the wait watched can be `running` again on
 *   a queued follow-up, so its live state and the settled status disagree and
 *   both have to be on the card.
 *
 * The suite drives the real registry entry through real React, so a renderer
 * that is registered but reads a field the engine does not emit fails here.
 * Field names are pinned against `coding-agent/src/tools/vibe.ts`
 * (`VibeToolDetails`) and `src/session/vibe-runtime.ts` (`VibeScreenSnapshot`,
 * `VibeSendOutcome`, `VibeKillOutcome`).
 *
 * What it does not catch: layout, ordering and styling. Only the facts drawn.
 */

const OPS = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

function render(name: string, component: "Summary" | "Body", props: Partial<ToolRenderProps> = {}): string {
	const renderer = resolveToolRenderer(name);
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`${name} renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name, args: {}, ...props } as ToolRenderProps));
}

function screen(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "worker-1",
		cli: "fast",
		state: "running",
		turns: 2,
		queued: 0,
		trace: [],
		outputTail: [],
		lastActivityAt: 1,
		...overrides,
	};
}

function result(details: Record<string, unknown>, text = "ok"): ToolResultLike {
	return { content: [{ type: "text", text }], details };
}

describe("every vibe op", () => {
	it("resolves to a renderer with both a summary and a body", () => {
		const missing = OPS.filter(name => {
			const renderer = resolveToolRenderer(name);
			return typeof renderer.Summary !== "function" || typeof renderer.Body !== "function";
		});
		expect(missing).toEqual([]);
	});

	it("draws the worker count from the shared screens snapshot", () => {
		for (const name of OPS) {
			const html = render(name, "Summary", {
				result: result({ op: name, screens: [screen(), screen({ id: "worker-2", state: "idle" })] }),
			});
			expect(html).toContain("1/2 on air");
		}
	});

	it("says nothing about workers before a result exists", () => {
		for (const name of OPS) {
			const html = render(name, "Summary", { running: true });
			expect(html).not.toContain("on air");
			expect(html).not.toContain("worker");
		}
	});
});

describe("a spawned worker", () => {
	it("names the flavor and the id the engine assigned, not the requested name", () => {
		const html = render("vibe_spawn", "Summary", {
			args: { cli: "good", name: "requested", prompt: "port the parser" },
			result: result({ op: "spawn", screens: [], spawned: { id: "assigned", cli: "good", jobId: "j1" } }),
		});
		expect(html).toContain("assigned");
		expect(html).not.toContain("requested");
		expect(html).toContain("good");
		expect(html).toContain("port the parser");
	});

	it("falls back to the requested name while the call is still in flight", () => {
		const html = render("vibe_spawn", "Summary", {
			args: { cli: "fast", name: "requested", prompt: "port the parser" },
			running: true,
		});
		expect(html).toContain("requested");
		expect(html).toContain("fast");
	});
});

describe("a message sent to a worker", () => {
	it("distinguishes a steered message from a queued one", () => {
		const steered = render("vibe_send", "Summary", {
			args: { session: "worker-1", message: "stop and re-read the spec" },
			result: result({ op: "send", screens: [], send: { id: "worker-1", mode: "steered" } }),
		});
		const queued = render("vibe_send", "Summary", {
			args: { session: "worker-1", message: "stop and re-read the spec" },
			result: result({ op: "send", screens: [], send: { id: "worker-1", mode: "queued" } }),
		});
		expect(steered).toContain("steered mid-turn");
		expect(steered).not.toContain("queued for the next turn");
		expect(queued).toContain("queued for the next turn");
		expect(queued).not.toContain("steered mid-turn");
	});

	it("reports a new turn as started", () => {
		const html = render("vibe_send", "Summary", {
			args: { session: "worker-1", message: "next task" },
			result: result({ op: "send", screens: [], send: { id: "worker-1", mode: "turn", jobId: "j2" } }),
		});
		expect(html).toContain("turn started");
	});
});

describe("a wait over the wall", () => {
	const waited = (wait: Record<string, unknown>): ToolResultLike =>
		result({
			op: "wait",
			screens: [screen({ id: "worker-1", state: "running" }), screen({ id: "worker-2", state: "idle" })],
			wait,
		});

	it("separates what settled from what is still running", () => {
		const html = render("vibe_wait", "Summary", {
			args: { sessions: ["worker-1", "worker-2"] },
			result: waited({
				settled: [{ id: "worker-2", jobId: "j2", status: "completed", resultText: "done" }],
				stillRunning: ["worker-1"],
				timedOut: false,
			}),
		});
		expect(html).toContain("1 settled");
		expect(html).toContain("1 still running");
		expect(html).not.toContain("timed out");
	});

	it("says a timed-out wait observed nothing, and names who held it up", () => {
		const html = render("vibe_wait", "Body", {
			args: { sessions: ["worker-1"] },
			result: waited({ settled: [], stillRunning: ["worker-1"], timedOut: true }),
		});
		// The whole sentence, because every worker id also appears on its own card
		// below: a note that merely said "timed out" would pass a looser check.
		expect(html).toContain("The wait timed out with worker-1 still running.");
	});

	it("does not invent a blocker when the timeout caught nothing running", () => {
		const html = render("vibe_wait", "Body", {
			result: waited({ settled: [], stillRunning: [], timedOut: true }),
		});
		expect(html).toContain("The wait timed out.");
		expect(html).not.toContain("still running.");
	});

	it("does not claim a timeout when the wait returned on its own", () => {
		const html = render("vibe_wait", "Body", {
			result: waited({ settled: [], stillRunning: [], timedOut: false }),
		});
		expect(html).not.toContain("timed out");
	});

	it("carries the settled status onto a worker that is already running again", () => {
		const html = render("vibe_wait", "Body", {
			result: result({
				op: "wait",
				screens: [screen({ id: "worker-1", state: "running" })],
				wait: {
					settled: [{ id: "worker-1", jobId: "j1", status: "failed", resultText: "boom" }],
					stillRunning: ["worker-1"],
					timedOut: false,
				},
			}),
		});
		expect(html).toContain("failed");
		expect(html).toContain("running");
	});

	it("marks an interim emission as still watching", () => {
		const html = render("vibe_wait", "Summary", {
			result: waited({ settled: [], stillRunning: ["worker-1"], timedOut: false, waiting: true }),
		});
		expect(html).toContain("watching");
	});
});

describe("a killed worker", () => {
	it("says when an in-flight turn was cancelled along the way", () => {
		const cancelled = render("vibe_kill", "Summary", {
			args: { session: "worker-1" },
			result: result({ op: "kill", screens: [], killed: { id: "worker-1", cancelledTurn: true } }),
		});
		const idle = render("vibe_kill", "Summary", {
			args: { session: "worker-1" },
			result: result({ op: "kill", screens: [], killed: { id: "worker-1", cancelledTurn: false } }),
		});
		expect(cancelled).toContain("in-flight turn cancelled");
		expect(idle).not.toContain("in-flight turn cancelled");
		expect(idle).toContain("worker-1");
	});
});

describe("a worker card", () => {
	it("draws the turn, the current activity, the trace and the output tail", () => {
		const html = render("vibe_list", "Body", {
			result: result({
				op: "list",
				screens: [
					screen({
						model: "sonnet",
						queued: 3,
						turnMessage: "port the parser",
						currentTool: "read",
						trace: ["bash", "read"],
						outputTail: ["reading parser.ts"],
					}),
				],
			}),
		});
		expect(html).toContain("sonnet");
		expect(html).toContain("2 turns");
		expect(html).toContain("3 queued");
		expect(html).toContain("port the parser");
		expect(html).toContain("read");
		expect(html).toContain("reading parser.ts");
	});

	it("prefers the current tool over the last intent, and the intent over stale activity", () => {
		const withTool = render("vibe_list", "Body", {
			result: result({
				op: "list",
				screens: [screen({ currentTool: "bash", lastIntent: "an older intent", lastActivity: "older still" })],
			}),
		});
		const withIntent = render("vibe_list", "Body", {
			result: result({
				op: "list",
				screens: [screen({ lastIntent: "an older intent", lastActivity: "older still" })],
			}),
		});
		expect(withTool).toContain("bash");
		expect(withTool).not.toContain("an older intent");
		expect(withIntent).toContain("an older intent");
		expect(withIntent).not.toContain("older still");
	});

	it("tones a dead worker as an error and one on air as active", () => {
		const toneOf = (state: string): string | undefined => {
			const html = render("vibe_list", "Body", {
				result: result({ op: "list", screens: [screen({ state })] }),
			});
			return new RegExp(`tv-badge tv-badge--(\\w+)">${state}<`).exec(html)?.[1];
		};
		expect(toneOf("dead")).toBe("err");
		expect(toneOf("running")).toBe("accent");
		expect(toneOf("starting")).toBe("accent");
		expect(toneOf("idle")).toBe("ok");
	});

	it("counts a starting worker as on air, the way the terminal does", () => {
		const html = render("vibe_list", "Summary", {
			result: result({ op: "list", screens: [screen({ state: "starting" })] }),
		});
		expect(html).toContain("1/1 on air");
	});
});

describe("an empty wall", () => {
	it("falls back to the tool's own text rather than drawing nothing", () => {
		const html = render("vibe_list", "Body", { result: result({ op: "list", screens: [] }, "no sessions") });
		expect(html).toContain("no sessions");
	});

	it("survives a details payload that carries no screens at all", () => {
		const html = render("vibe_list", "Body", { result: { content: [{ type: "text", text: "nothing yet" }] } });
		expect(html).toContain("nothing yet");
	});
});
