/**
 * WHY: a toast is an interruption, so it is worth one only when the session cannot continue without
 * the operator.
 *
 * Both notification settings shipped defaulting to `on`. Completion fired at the end of every turn,
 * dozens per session, announcing what was already on the screen in front of whoever was watching it.
 * The operator's own reading of it: waiting on an unanswered question is the one case that earns a
 * toast. So completion defaults off, `ask` stays on, and the window-focus gate in `packages/tui`
 * withholds even that one while the terminal has focus.
 *
 * THE CLASS THIS CLOSES: every setting that gates a desktop notification has a RECORDED decision, and
 * its default matches it. The membership is read out of `SETTINGS_SCHEMA` at run time, so a third
 * `*.notify` setting cannot be added without recording why it notifies: it lands in neither column and
 * the suite goes red. A blank reason does not count as a decision, and an entry for a setting the
 * schema no longer declares goes red too, so the table cannot rot into a list of names.
 *
 * WHAT IT DOES NOT CATCH: a NEW notification sender that consults no setting at all, or one that reads
 * a setting whose key does not end in `.notify`. Nothing here can see a `TERMINAL.sendNotification`
 * call added with no gate; the focus gate is the backstop for that and has its own suite
 * (`packages/tui/test/notifications-respect-window-focus.test.ts`). It also says nothing about whether
 * the toast an opted-in operator gets is well formed, which the abort-guard suite owns.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { EventController } from "@veyyon/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { TERMINAL } from "@veyyon/tui";
import { useTrackedTempDirs } from "../../helpers/tracked-temp-dir";

const makeOptInDir = useTrackedTempDirs("veyyon-notify-optin-");

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: makeOptInDir() });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

/** Every notification gate the product declares, discovered from the schema rather than listed. */
function notifySettingKeys(): string[] {
	return Object.keys(SETTINGS_SCHEMA)
		.filter(key => key.endsWith(".notify"))
		.sort();
}

/**
 * The recorded decision per gate. A toast is worth an interruption only when the session cannot go on
 * without the operator, so `on` needs a sentence saying why this event is that.
 */
const NOTIFY_DECISIONS: Readonly<Record<string, { default: "on" | "off"; because: string }>> = {
	"completion.notify": {
		default: "off",
		because: "a finished turn is on the screen the operator is already looking at",
	},
	"ask.notify": {
		default: "on",
		because: "the turn has stopped and cannot continue until the operator answers",
	},
};

function makeContext(stopReason: "stop" | "aborted"): InteractiveModeContext {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
	const sessionMock = { getLastAssistantMessage: () => message };
	return {
		sessionManager: { getSessionName: () => "test-session" },
		session: sessionMock,
		viewSession: sessionMock,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
}

describe("a toast is for the question you have not answered", () => {
	it("records a decision for every notification gate the product declares", () => {
		// Read from the schema, not from a list here: a new `*.notify` setting lands in neither column.
		const declared = notifySettingKeys();
		expect(declared.length).toBeGreaterThanOrEqual(2);
		expect(declared.filter(key => (NOTIFY_DECISIONS[key]?.because ?? "").trim() === "")).toEqual([]);
		// And the table cannot outlive the settings it describes.
		expect(Object.keys(NOTIFY_DECISIONS).filter(key => !declared.includes(key))).toEqual([]);
	});

	it("defaults every notification gate to its recorded decision", () => {
		const actual = Object.fromEntries(notifySettingKeys().map(key => [key, settings.get(key as never) as unknown]));
		const recorded = Object.fromEntries(notifySettingKeys().map(key => [key, NOTIFY_DECISIONS[key]?.default]));
		expect(actual).toEqual(recorded);
	});

	it("sends no completion toast for an operator who never opted in", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		new EventController(makeContext("stop")).sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("still sends the completion toast once an operator turns it on", () => {
		// The negative control: without this, defaulting the reader to a hard `return` would pass.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		new EventController(makeContext("stop")).sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
