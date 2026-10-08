/**
 * ctrl+x in the `/resume` picker stops a conversation running off-screen without resuming it.
 *
 * WHY THIS SUITE EXISTS: a conversation `/new` left running in the background could only be ended
 * by resuming it onto the screen and interrupting it there, so the one conversation an operator
 * wanted to end without reading was the one that had to be read first. The class is "the picker
 * stops the wrong conversation, stops none, or stops one twice": every case drives the real
 * picker against the real `BackgroundSessions` registry and asserts which turns were aborted and
 * which entries left the set.
 *
 * Not caught: a conversation whose own abort ignores its signal (the entry leaves the set only
 * when its turn settles), and the `SessionManager.list` scan that decides which transcripts the
 * picker lists at all.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/session-selector";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions, runningConversations } from "@veyyon/coding-agent/session/background-sessions";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionInfo } from "@veyyon/kernel/session/session-listing";
import { stripAnsi } from "@veyyon/utils";

const CTRL_X = "\x18";
const DOWN = "\x1b[B";

interface FakeConversation {
	readonly aborts: string[];
	readonly session: AgentSession;
	readonly info: SessionInfo;
	finish(): void;
}

/**
 * A conversation whose turn runs until it finishes or is aborted. `abortSettles` false models an
 * abort still unwinding: the stream is asked to stop and the turn has not ended yet.
 */
function conversation(id: string, title: string, abortSettles = true): FakeConversation {
	const turn = Promise.withResolvers<void>();
	const aborts: string[] = [];
	const file = `/repo/sessions/${id}.jsonl`;
	const session = {
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => title,
			getSessionFile: () => file,
			flush: async () => {},
		},
		waitForIdle: () => turn.promise,
		waitForQuiescence: () => turn.promise,
		dispose: async () => {},
		abort: async (options?: { reason?: string }) => {
			aborts.push(options?.reason ?? "");
			if (abortSettles) turn.resolve();
		},
	} as unknown as AgentSession;
	const info: SessionInfo = {
		// Not the string the session reports: the picker lists what the directory scan found.
		path: `/repo/sessions/../sessions/${id}.jsonl`,
		id,
		cwd: "/repo",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
	return { aborts, session, info, finish: () => turn.resolve() };
}

function picker(rows: readonly SessionInfo[]): SessionSelectorComponent {
	return new SessionSelectorComponent(
		[...rows],
		() => {},
		() => {},
		() => {},
		{
			getTerminalRows: () => 100,
			running: runningConversations(BackgroundSessions.global(), USER_INTERRUPT_LABEL),
		},
	);
}

function screen(selector: SessionSelectorComponent): string {
	return stripAnsi(selector.render(140).join("\n"));
}

/** The metadata line under the row titled `title`. */
function metadataOf(selector: SessionSelectorComponent, title: string): string {
	const lines = screen(selector).split("\n");
	const at = lines.findIndex(line => line.includes(title));
	return lines[at + 2] ?? "";
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await nextTurn();
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await BackgroundSessions.global().drain(100);
});

describe("stopping a background conversation from /resume", () => {
	it("aborts the selected conversation's turn, empties its entry, and keeps its row", async () => {
		const alpha = conversation("session-a", "Alpha");
		BackgroundSessions.global().keep(alpha.session, 3);
		const selector = picker([alpha.info]);

		expect(metadataOf(selector, "Alpha")).toContain("running");
		expect(screen(selector)).toContain("ctrl+x stop");

		selector.handleInput(CTRL_X);
		await settle();

		expect(alpha.aborts).toEqual([USER_INTERRUPT_LABEL]);
		expect(BackgroundSessions.global().size).toBe(0);
		expect(screen(selector)).toContain("Stopped Alpha.");
		expect(screen(selector)).toContain("Alpha");
		expect(metadataOf(selector, "Alpha")).not.toContain("running");
		expect(screen(selector)).not.toContain("ctrl+x stop");
	});

	it("stops only the row under the cursor", async () => {
		const alpha = conversation("session-a", "Alpha");
		const beta = conversation("session-b", "Beta");
		BackgroundSessions.global().keep(alpha.session, 3);
		BackgroundSessions.global().keep(beta.session, 3);
		const selector = picker([alpha.info, beta.info]);

		selector.handleInput(DOWN);
		selector.handleInput(CTRL_X);
		await settle();

		expect(beta.aborts).toEqual([USER_INTERRUPT_LABEL]);
		expect(alpha.aborts).toEqual([]);
		expect(
			BackgroundSessions.global()
				.list()
				.map(entry => entry.sessionId),
		).toEqual(["session-a"]);
		expect(metadataOf(selector, "Alpha")).toContain("running");
		alpha.finish();
	});

	it("aborts once when ctrl+x repeats while the abort is still unwinding", async () => {
		const alpha = conversation("session-a", "Alpha", false);
		BackgroundSessions.global().keep(alpha.session, 3);
		const selector = picker([alpha.info]);

		selector.handleInput(CTRL_X);
		selector.handleInput(CTRL_X);
		await settle();

		expect(alpha.aborts).toEqual([USER_INTERRUPT_LABEL]);
		expect(screen(selector)).toContain("Stopping Alpha");
		alpha.finish();
		await settle();
		expect(BackgroundSessions.global().size).toBe(0);
		expect(screen(selector)).toContain("Stopped Alpha.");
	});

	it("leaves every conversation alone when the cursor row is not running", async () => {
		const alpha = conversation("session-a", "Alpha");
		const idle = conversation("session-idle", "Idle");
		BackgroundSessions.global().keep(alpha.session, 3);
		const selector = picker([idle.info, alpha.info]);

		expect(screen(selector)).not.toContain("ctrl+x stop");
		selector.handleInput(CTRL_X);
		await settle();

		expect(alpha.aborts).toEqual([]);
		expect(idle.aborts).toEqual([]);
		expect(BackgroundSessions.global().size).toBe(1);
		expect(screen(selector)).toContain("Idle is not running.");
		alpha.finish();
	});
});
