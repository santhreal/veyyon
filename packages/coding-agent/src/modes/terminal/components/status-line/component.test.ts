import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { makeStatusLineSession } from "../../../../../test/helpers/status-line-session";
import { Settings } from "../../../../config/settings";
import type { AgentSession } from "../../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../../../theme/theme";
import { StatusLineComponent } from "./component";

function makeSessionWithLastMessage(lastMessage: unknown, prewalkArmed = false): AgentSession {
	return makeStatusLineSession({
		messages: lastMessage ? [lastMessage] : [],
		contextUsage: { tokens: 42, contextWindow: 128_000 },
		prewalk: prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined,
	});
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession);

		// The default preset puts `mode` in the footline's capability group.
		const line = statusLine.renderQuietLine(100);
		expect(line).not.toBeNull();
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		expect(stripAnsi(line ?? "")).toContain("Prewalk");
	});
});
