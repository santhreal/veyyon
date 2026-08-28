import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * The web view of the daemon tool.
 *
 * WHY THIS SUITE EXISTS. `launch` had no renderer, so eight different operations
 * all arrived as the same JSON dump. The question a reader has is always the
 * same one and the dump answers it worst: is the thing running? A dev server
 * that came up and one that exited three seconds later differ by a state string
 * and an exit code buried in a nested object.
 *
 * Two distinctions get the most attention here because getting them wrong is
 * actively misleading rather than merely unhelpful: a `wait` that TIMED OUT did
 * not observe what it was waiting for, and a daemon killed by a SIGNAL did not
 * choose its exit code. Both look almost identical to their opposite in JSON.
 */

const renderer = resolveToolRenderer("launch");

function render(component: "Summary" | "Body", props: Partial<ToolRenderProps>): string {
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`launch renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name: "launch", args: {}, ...props } as ToolRenderProps));
}

function started(overrides: Record<string, unknown> = {}): ToolResultLike {
	return {
		content: [{ type: "text", text: "Started dev-server." }],
		details: {
			op: "start",
			daemon: {
				name: "dev-server",
				id: "d1",
				state: "ready",
				pid: 4242,
				createdAt: 1,
				startedAt: 2,
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
				...overrides,
			},
		},
	};
}

describe("launch summary", () => {
	/** State first: it is the only thing a reader is actually asking about. */
	it("names the daemon and its state", () => {
		const html = render("Summary", { args: { op: "start", name: "dev-server" }, result: started() });

		expect(html).toContain("dev-server");
		expect(html).toContain("ready");
		expect(html).toContain("tv-badge--ok");
	});

	/** A failed daemon must not read like a healthy one at a glance. */
	it("marks a failed daemon as an error", () => {
		const html = render("Summary", { args: { op: "start" }, result: started({ state: "failed" }) });

		expect(html).toContain("failed");
		expect(html).toContain("tv-badge--err");
	});

	/** `exited` is neither healthy nor an error: it ran and stopped. */
	it("marks an exited daemon as a warning rather than an error", () => {
		const html = render("Summary", { args: { op: "stop" }, result: started({ state: "exited", exitCode: 0 }) });

		expect(html).toContain("exited");
		expect(html).toContain("tv-badge--warn");
		expect(html).not.toContain("tv-badge--err");
	});

	/**
	 * THE DISTINCTION THAT MATTERS MOST. A `wait` that timed out did NOT see what
	 * it was waiting for, so a reader who takes it as a completed wait draws the
	 * opposite conclusion from the truth.
	 */
	it("says when a wait timed out", () => {
		const result: ToolResultLike = {
			content: [{ type: "text", text: "Timed out." }],
			details: { op: "wait", timedOut: true },
		};

		const html = render("Summary", { args: { op: "wait", name: "dev-server" }, result });

		expect(html).toContain("timed out");
	});

	it("does not claim a timeout when there was none", () => {
		const result: ToolResultLike = {
			content: [],
			details: { op: "wait", timedOut: false, matched: "Listening on 3000" },
		};

		const html = render("Summary", { args: { op: "wait" }, result });

		expect(html).not.toContain("timed out");
	});

	/** A `list` answers about several daemons, so the count is the headline. */
	it("counts the daemons a list returned", () => {
		const result: ToolResultLike = {
			content: [],
			details: {
				op: "list",
				daemons: [
					{ name: "a", id: "1", state: "ready" },
					{ name: "b", id: "2", state: "exited", exitCode: 1 },
				],
			},
		};

		const html = render("Summary", { args: { op: "list" }, result });

		expect(html).toContain("2 daemons");
	});

	/** One daemon in a list is still one daemon, and reads as itself. */
	it("shows the single daemon of a one-entry list rather than a count", () => {
		const result: ToolResultLike = {
			content: [],
			details: { op: "list", daemons: [{ name: "only", id: "1", state: "running" }] },
		};

		const html = render("Summary", { args: { op: "list" }, result });

		expect(html).toContain("only");
		expect(html).toContain("running");
		expect(html).not.toContain("1 daemon<");
	});

	/** While the call runs there is no result, so the argument names the op. */
	it("falls back to the requested op while running", () => {
		const html = render("Summary", { args: { op: "stop", name: "dev-server" }, running: true });

		expect(html).toContain("stop");
		expect(html).toContain("dev-server");
	});
});

describe("launch body", () => {
	/**
	 * THE SECOND DISTINCTION. A process killed by a signal did not choose its exit
	 * code, and only the signal field says so; reporting a bare number would invite
	 * the reader to interpret a death as a decision.
	 */
	it("reports a signal death as a signal, not an exit code", () => {
		const result = started({ state: "exited", signal: "SIGKILL", exitCode: 137 });

		const html = render("Body", { args: { op: "stop" }, result });

		expect(html).toContain("killed by SIGKILL");
		expect(html).not.toContain("exit 137");
	});

	/** A zero exit is a clean stop and should read as one. */
	it("names a zero exit as a clean exit", () => {
		const result = started({ state: "exited", exitCode: 0 });

		const html = render("Body", { args: { op: "stop" }, result });

		expect(html).toContain("exited cleanly");
	});

	it("shows a non-zero exit code", () => {
		const result = started({ state: "failed", exitCode: 2, exitReason: "port already in use" });

		const html = render("Body", { args: { op: "start" }, result });

		expect(html).toContain("exit 2");
		expect(html).toContain("port already in use");
	});

	/** Restarts are invisible in the state alone and change what "running" means. */
	it("surfaces a restart count when the daemon has restarted", () => {
		const html = render("Body", { args: { op: "list" }, result: started({ restartCount: 3 }) });

		expect(html).toContain("restarts");
		expect(html).toContain("3");
	});

	it("says nothing about restarts when there have been none", () => {
		const html = render("Body", { args: { op: "list" }, result: started({ restartCount: 0 }) });

		expect(html).not.toContain("restarts");
	});

	/**
	 * The matched line is the proof a `wait` succeeded rather than merely stopping,
	 * which is what separates it from the timeout case above.
	 */
	it("shows the line that satisfied a wait", () => {
		const result: ToolResultLike = {
			content: [],
			details: {
				op: "wait",
				daemon: { name: "dev-server", id: "d1", state: "ready" },
				matched: "Listening on 3000",
			},
		};

		const html = render("Body", { args: { op: "wait" }, result });

		expect(html).toContain("Listening on 3000");
	});

	/** `logs` is the reason anyone opens the body of a launch call. */
	it("renders the terminal rows a logs call returned", () => {
		const result: ToolResultLike = {
			content: [],
			details: { op: "logs", state: "running", terminalRows: ["build started", "compiled in 1.2s", "ready"] },
		};

		const html = render("Body", { args: { op: "logs" }, result });

		expect(html).toContain("build started");
		expect(html).toContain("compiled in 1.2s");
	});

	/** `describe` returns the immutable spec, which is what the daemon actually runs. */
	it("shows the command and directory from a describe", () => {
		const result: ToolResultLike = {
			content: [],
			details: {
				op: "describe",
				daemon: { name: "dev-server", id: "d1", state: "ready" },
				spec: { name: "dev-server", application: "bun", args: ["run", "dev"], cwd: "/work/app" },
			},
		};

		const html = render("Body", { args: { op: "describe" }, result });

		expect(html).toContain("bun run dev");
		expect(html).toContain("/work/app");
	});

	/** Several daemons stay one scannable block rather than a nest of objects. */
	it("lists every daemon with its own state", () => {
		const result: ToolResultLike = {
			content: [],
			details: {
				op: "list",
				daemons: [
					{ name: "api", id: "1", state: "ready", pid: 10 },
					{ name: "worker", id: "2", state: "failed", exitCode: 1 },
				],
			},
		};

		const html = render("Body", { args: { op: "list" }, result });

		expect(html).toContain("api");
		expect(html).toContain("worker");
		expect(html).toContain("ready");
		expect(html).toContain("failed");
		expect(html).toContain("exit 1");
	});
});

describe("launch renderer tolerates malformed wire data", () => {
	/**
	 * `details` is plain JSON from the wire. These are the shapes that would have
	 * thrown: a daemon that is not an object, a `daemons` field that is not an
	 * array, terminal rows that are not strings, and no details at all.
	 */
	it("ignores a daemon that is not an object", () => {
		const result: ToolResultLike = { content: [], details: { op: "start", daemon: "dev-server" } };

		expect(() => render("Body", { args: {}, result })).not.toThrow();
		expect(render("Summary", { args: {}, result })).toContain("start");
	});

	it("ignores a daemons field that is not an array", () => {
		const result: ToolResultLike = { content: [], details: { op: "list", daemons: { name: "a" } } };

		expect(() => render("Body", { args: {}, result })).not.toThrow();
		expect(render("Summary", { args: {}, result })).not.toContain("daemons");
	});

	it("keeps only the string terminal rows", () => {
		const result: ToolResultLike = {
			content: [],
			details: { op: "logs", terminalRows: ["kept", 42, null, { row: "x" }] },
		};

		const html = render("Body", { args: {}, result });

		expect(html).toContain("kept");
		expect(html).not.toContain("42");
	});

	it("renders with no details at all", () => {
		// A launch call whose result has not landed still has to say which
		// operation is in flight; a blank card is indistinguishable from a
		// renderer that broke.
		expect(render("Body", { args: { op: "list" } })).toContain("list");
		expect(render("Summary", { args: {} })).toContain("launch");
	});
});
