/**
 * WHY. The ask tool called `TERMINAL.sendNotification` directly, so the only host
 * that could tell an operator a question was waiting was a terminal, and a GUI
 * attaching to this core would have had to import the terminal package to get it.
 * The tool now emits a host-agnostic `HostNotification` through `ToolSession.notify`,
 * which whichever host is running installs.
 *
 * THE CLASS THIS CLOSES. A tool reaching a host facility by naming one host. The
 * capability is REPORTED rather than no-oped: absent means nothing here can reach an
 * operator, so the tool sends nothing instead of calling into a stub that reports
 * success. Every cell drives the real `AskTool.execute` through the real dialog path
 * and reads what the host was handed.
 *
 * WHAT IT DOES NOT CATCH. Whether a terminal paints the notification, which is
 * `TERMINAL.sendNotification`'s own contract; `TerminalNotification extends
 * HostNotification` is what holds the two shapes together, and a field renamed on
 * either side fails the build. It also says nothing about the two remaining
 * `TERMINAL.sendNotification` callers, which sit inside the terminal host where
 * naming the terminal is correct.
 *
 * It also does not catch a FAKE host that lacks the capability the terminal
 * controller installs. Every such fake is cast (`as unknown as
 * InteractiveModeContext`), so `check:ts` cannot see the missing member, and the
 * omission shows up only as a `TypeError` when a suite runs the real controller.
 * Adding a member to that install list therefore means running
 * `extension-ui-controller.test.ts` and every suite that builds a controller
 * context, not trusting the type check.
 */
import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@veyyon/agent-core";
import type { HostNotification } from "@veyyon/utils/host-notification";
import type { ToolSession } from "../src/tools";
import { AskTool } from "../src/tools/agent/ask";
import { makeToolSession } from "./helpers/tool-session";

const QUESTIONS = [
	{
		id: "pick",
		question: "Which one?",
		options: [{ label: "left" }, { label: "right" }],
	},
];

/**
 * A host context that answers the dialog immediately, so `execute` runs its whole
 * production path — validation, notification, dialog, result — without blocking.
 */
function answeringContext(): AgentToolContext {
	return {
		hasUI: true,
		ui: {
			askDialog: () => Promise.resolve({ kind: "answers", results: [{ id: "pick", selectedOptions: ["left"] }] }),
		},
		abort: () => {},
	} as unknown as AgentToolContext;
}

/** A host that CAN reach an operator: it installed a notifier. */
function hostWithNotifier(askNotify: string): { delivered: HostNotification[]; session: ToolSession } {
	const delivered: HostNotification[] = [];
	const session = makeToolSession({
		hasUI: true,
		notify: notification => {
			delivered.push(notification);
		},
		settings: {
			get: (key: string) => {
				if (key === "ask.notify") return askNotify;
				if (key === "ask.timeout") return 0;
				return undefined;
			},
		},
	});
	return { delivered, session };
}

/** A host that cannot: it installed no notifier, so the capability reads undefined. */
function hostWithoutNotifier(): ToolSession {
	return makeToolSession({
		hasUI: true,
		settings: {
			get: (key: string) => {
				if (key === "ask.notify") return "on";
				if (key === "ask.timeout") return 0;
				return undefined;
			},
		},
	});
}

describe("a tool asks its host to notify, and names no host", () => {
	it("hands the host a payload carrying no terminal concept", async () => {
		const { delivered, session } = hostWithNotifier("on");
		const tool = AskTool.createIf(session);
		expect(tool).not.toBeNull();
		if (!tool) return;

		await tool.execute("call-1", { questions: QUESTIONS }, undefined, undefined, answeringContext());

		// Every field states something about the message. A terminal-only control —
		// sound, icon name, expiry, delivery while the window holds focus — appearing
		// here would mean the tool had gone back to describing one host's mechanism.
		expect(delivered).toEqual([
			{ title: "Veyyon", body: "Waiting for input", type: "ask", urgency: "normal", actions: "focus" },
		]);
	});

	it("sends nothing when the operator turned the notification off", async () => {
		const { delivered, session } = hostWithNotifier("off");
		const tool = AskTool.createIf(session);
		expect(tool).not.toBeNull();
		if (!tool) return;

		await tool.execute("call-2", { questions: QUESTIONS }, undefined, undefined, answeringContext());

		expect(delivered).toEqual([]);
	});

	it("still answers the question on a host that installed no notifier", async () => {
		const session = hostWithoutNotifier();
		// The absent capability is the point: a headless run, a print-mode run and a
		// GUI with no desktop channel all land here, and none of them may fail a
		// question because nobody could be paged about it.
		expect(session.notify).toBeUndefined();
		const tool = AskTool.createIf(session);
		expect(tool).not.toBeNull();
		if (!tool) return;

		const result = await tool.execute("call-3", { questions: QUESTIONS }, undefined, undefined, answeringContext());

		expect(result.isError).toBeFalsy();
	});

	it("does not notify about a question that is never shown", async () => {
		const { delivered, session } = hostWithNotifier("on");
		const tool = AskTool.createIf(session);
		expect(tool).not.toBeNull();
		if (!tool) return;

		const result = await tool.execute("call-4", { questions: [] }, undefined, undefined, answeringContext());

		expect(result.isError).toBe(true);
		expect(delivered).toEqual([]);
	});
});
