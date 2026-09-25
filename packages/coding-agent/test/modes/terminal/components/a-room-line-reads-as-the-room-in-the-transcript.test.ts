/**
 * WHY: a line of the room's `#room` channel lands in a conversation's
 * transcript and in its `history://` text. The defect class closed here is a
 * room line that reads as something else there: as a direct message, as a
 * generic custom block with the model-facing prompt as its body, or not at all
 * once the transcript is rebuilt from the session file.
 *
 * The record under test is the one a real AgentSession writes when it takes the
 * line, so the card and the history line are read from the production shape,
 * not a restatement of it. A record whose details another build wrote wrong
 * still draws as a room card.
 *
 * What it does NOT catch: the card's colours, or the live card's expiry, which
 * the event controller owns for every irc card alike.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	TranscriptBlockComponent,
	type TranscriptBlockComponentOptions,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-block-component";
import { toTranscriptBlock } from "@veyyon/coding-agent/presentation/transcript-builder";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type CustomMessage, IRC_ROOM_MESSAGE_TYPE } from "@veyyon/coding-agent/session/messages";
import { formatSessionHistoryMarkdown } from "@veyyon/coding-agent/session/session-history-format";
import type { IrcRoomLine } from "@veyyon/coding-agent/task/irc-bus";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

initTheme();

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

const options: TranscriptBlockComponentOptions = {
	tui: { requestRender: () => {}, requestComponentRender: () => {}, imageBudget: undefined } as unknown as TUI,
	onRequestRender: () => {},
};

function line(label: string, body: string, from?: string): IrcRoomLine {
	return { id: `${label}:${body}`, ...(from ? { from } : {}), label, body, ts: 1_700_000_000_000 };
}

/** The record a conversation keeps for `lines`, taken the way the bus hands them over. */
function recordOf(lines: IrcRoomLine[], backlog = false): CustomMessage {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model to exist");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: {} as never,
	});
	sessions.push(session);
	session.deliverRoomLines(lines, { named: false, wake: false, backlog });
	const record = session.agent.state.messages.find(
		(message): message is CustomMessage => message.role === "custom" && message.customType === IRC_ROOM_MESSAGE_TYPE,
	);
	if (!record) throw new Error("the conversation kept no room record");
	return record;
}

function card(record: CustomMessage): string {
	const component = new TranscriptBlockComponent(toTranscriptBlock(record, { index: 0 }), options);
	const text = component.render(100).map(stripAnsi).join("\n");
	component.dispose();
	return text;
}

describe("a #room line in the transcript", () => {
	it("is a #room card titled with its poster, with the message as its body, and not the prompt the model read", () => {
		const shown = card(recordOf([line("2 · parser whitespace", "tokenize now takes (src, opts)", "main:b")]));
		expect(shown).toContain("#room");
		expect(shown).toContain("2 · parser whitespace");
		expect(shown).toContain("tokenize now takes (src, opts)");
		expect(shown).not.toContain("IRC");
		expect(shown).not.toContain("Every driving conversation");
	});

	it("titles the operator's post as `you`", () => {
		expect(card(recordOf([line("you", "freeze main")]))).toMatch(/#room \S+ you/);
	});

	it("draws a backlog as one card of every line, each with its poster", () => {
		const shown = card(
			recordOf([line("2 · parser whitespace", "parser.ts is mine", "main:b"), line("you", "tests are green")], true),
		);
		expect(shown).toContain("#room · before this conversation joined");
		expect(shown).toContain("2 · parser whitespace: parser.ts is mine");
		expect(shown).toContain("you: tests are green");
	});

	it("draws a record another build wrote wrong as a room card, not a crash or a raw block", () => {
		const record: CustomMessage = {
			role: "custom",
			customType: IRC_ROOM_MESSAGE_TYPE,
			content: '<irc channel="#room">unreadable</irc>',
			display: true,
			details: { lines: "not a list" },
			attribution: "agent",
			timestamp: 1_700_000_000_000,
		};
		const shown = card(record);
		expect(shown).toContain("#room");
		expect(shown).not.toContain("unreadable");
	});
});

describe("a #room line in history://", () => {
	it("reads as one `[#room]` line: poster and message, every line of a backlog", () => {
		const live = recordOf([line("2 · parser whitespace", "tokenize now takes\n(src, opts)", "main:b")]);
		const backlog = recordOf([line("conversation 3", "one", "main:c"), line("you", "two")], true);
		const text = formatSessionHistoryMarkdown([live, backlog]);
		expect(text).toContain("[#room] 2 · parser whitespace: tokenize now takes (src, opts)");
		expect(text).toContain("[#room] conversation 3: one · you: two");
	});
});
