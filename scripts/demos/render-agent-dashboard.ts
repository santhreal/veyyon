/**
 * Render the agent dashboard across roster, inspector, and communication views.
 *
 * Registers mock subagents with activity logs, models, and timestamps, and injects IRC
 * traffic across sessions. Constructs the agent dashboard component and renders live
 * roster views, row hover actions, termination confirmation overlays, or comms message
 * streams as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-agent-dashboard.ts [--view live|live-hover|termination|comms|comms-filtered] [--width 100] [--height 34] [--theme titanium]
 *
 * Views: `live` (the roster), `live-hover` (the roster's pointer affordance),
 * `termination` (the confirmation reached through that affordance), and `comms`
 * (the message stream). The card used to carry a configuration list of the
 * agent TYPES a stock install ships, which said nothing about what was running
 * and could not be opened; `/settings` -> Agents owns that table.
 */

import type { Component, TUI } from "../../hosts/terminal/engine/src";
import { AgentDashboard } from "../../packages/coding-agent/src/modes/terminal/components/dashboard/agent-dashboard";
import { AgentRegistry, MAIN_AGENT_ID } from "../../packages/coding-agent/src/registry/agent-registry";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { IrcBus } from "../../packages/coding-agent/src/task/irc-bus";
import { renderDemo } from "./render-args";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function positionOf(lines: readonly string[], needle: string): { row: number; col: number } {
	const plain = lines.map(line => line.replace(ANSI_PATTERN, ""));
	const row = plain.findIndex(line => line.includes(needle));
	if (row < 0) throw new Error(`agent dashboard proof could not find ${JSON.stringify(needle)}`);
	return { row: row + 1, col: plain[row]!.indexOf(needle) + 1 };
}

function acceptingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "injected",
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

await renderDemo(
	async ({ width, height, flag }) => {
		const view = flag("view", "live");
		const registry = AgentRegistry.global();

		registry.register({ id: MAIN_AGENT_ID, displayName: "Main Session", kind: "main", session: acceptingSession() });
		registry.register({
			id: "task-7f21",
			displayName: "scout",
			kind: "sub",
			session: acceptingSession(),
			model: "anthropic/claude-opus-5",
		});
		registry.setActivity("task-7f21", "reading agent-dashboard.ts, 1,436 lines");

		registry.register({
			id: "task-b904",
			displayName: "reviewer",
			kind: "sub",
			session: acceptingSession(),
			model: "anthropic/claude-sonnet-5",
		});
		registry.setActivity("task-b904", "grep for enableStateDisplay callers");

		registry.register({
			id: "task-3ac8",
			displayName: "librarian",
			kind: "sub",
			session: null,
			model: "anthropic/claude-sonnet-5",
		});
		registry.setStatus("task-3ac8", "idle");

		const now = Date.now();
		const stamp = (id: string, ageMs: number, idleMs: number) => {
			const ref = registry.get(id);
			if (!ref) return;
			ref.createdAt = now - ageMs;
			ref.lastActivity = now - idleMs;
		};
		stamp(MAIN_AGENT_ID, 14 * 60_000, 4_000);
		stamp("task-7f21", 6 * 60_000, 3_000);
		stamp("task-b904", 4 * 60_000, 3 * 60_000);
		stamp("task-3ac8", 9 * 60_000, 8 * 60_000);

		const traffic: Array<[string, string, string, number]> = [
			["task-7f21", MAIN_AGENT_ID, "The tab strip filters on AgentSource and nothing downstream reads it.", 260_000],
			[MAIN_AGENT_ID, "task-b904", "Take the inspector next. Seven of nine lines are model resolution.", 190_000],
			["task-b904", "task-7f21", "Which file holds the badge formatter? I have two that disagree.", 120_000],
			["task-7f21", "task-b904", "agent-model-badge.ts. It is one owner now, shared with the task widget.", 74_000],
			["task-b904", "task-3ac8", "Collect the theme matrix when you are done.", 22_000],
		];
		const sentIds: string[] = [];
		for (const [index, [from, to, body]] of traffic.entries()) {
			const replyTo = index === 3 ? sentIds[2] : undefined;
			await IrcBus.global().send({ from, to, body, ...(replyTo ? { replyTo } : {}) });
			sentIds.push(IrcBus.global().log().at(-1)?.message.id ?? "");
		}
		const log = IrcBus.global().log();
		for (const [index, entry] of log.entries()) {
			const age = traffic[index]?.[3];
			if (age !== undefined) entry.message.ts = now - age;
		}

		let overlay: Component | undefined;
		const ui = {
			requestRender: () => {},
			requestComponentRender: () => {},
			showOverlay: (component: Component) => {
				overlay = component;
				return {
					hide: () => {
						if (overlay === component) overlay = undefined;
					},
				};
			},
			setFocus: () => {},
		} as unknown as TUI;

		const dashboard = new AgentDashboard({ terminalHeight: height, showModelBadge: true, ui });
		if (view === "comms" || view === "comms-filtered") dashboard.handleInput("\x1b[C");
		if (view === "comms-filtered") {
			dashboard.handleInput("f");
			dashboard.handleInput("f");
		}
		let lines = dashboard.render(width);
		if (view === "live-hover" || view === "termination") {
			const scout = positionOf(lines, "scout");
			dashboard.handleInput(`\x1b[<35;${scout.col};${scout.row}M`);
			lines = dashboard.render(width);
		}
		if (view === "termination") {
			const scout = positionOf(lines, "scout");
			const scoutLine = lines[scout.row - 1]!.replace(ANSI_PATTERN, "");
			const terminateCol = scoutLine.lastIndexOf("[x]") + 1;
			if (terminateCol === 0) throw new Error("agent dashboard proof did not reveal the row termination action");
			dashboard.handleInput(`\x1b[<0;${terminateCol};${scout.row}M`);
			if (!overlay) throw new Error("agent dashboard proof did not mount the termination confirmation");
			lines = overlay.render(width);
		}

		dashboard.dispose();
		return lines;
	},
	{ defaultHeight: 34 },
);
