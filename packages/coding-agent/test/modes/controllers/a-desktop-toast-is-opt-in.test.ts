/**
 * WHY: a desktop toast is an interruption, so it is something an operator asks for.
 *
 * Both notification settings shipped defaulting to `on`, which meant an operator who never asked for
 * notifications got a toast at the end of every turn and again every time the `ask` tool waited.
 * Across one working session that is dozens of interruptions announcing information already on the
 * screen in front of them. The reported symptom was "these notifications are infuriating"; the defect
 * is that nobody opted in.
 *
 * THE CLASS THIS CLOSES: any setting that gates a desktop notification defaults to off. The
 * membership is read out of `SETTINGS_SCHEMA` at run time rather than listed here, so adding a third
 * `*.notify` setting that ships on turns this suite red instead of shipping another surprise toast.
 *
 * WHAT IT DOES NOT CATCH: a NEW notification sender that consults no setting at all, or one that
 * reads a setting whose key does not end in `.notify`. Nothing here can see a `TERMINAL.sendNotification`
 * call added with no gate; the focus gate in `packages/tui` is the backstop for that, and it has its
 * own suite (`packages/tui/test/notifications-respect-window-focus.test.ts`). It also says nothing
 * about whether the toast an opted-in operator gets is well formed, which the abort-guard suite owns.
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

describe("a desktop toast is opt-in", () => {
	it("declares at least the two notification gates it is written about", () => {
		// A filter that silently matched nothing would make every case below vacuous.
		expect(notifySettingKeys()).toEqual(expect.arrayContaining(["ask.notify", "completion.notify"]));
	});

	it("defaults every notification gate to off", () => {
		const defaults = Object.fromEntries(
			notifySettingKeys().map(key => [key, settings.get(key as never) as unknown]),
		);
		expect(defaults).toEqual(Object.fromEntries(notifySettingKeys().map(key => [key, "off"])));
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
