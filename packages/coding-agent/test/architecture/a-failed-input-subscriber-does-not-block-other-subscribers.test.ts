/**
 * WHY: a throwing presentation subscriber prevented later subscribers from receiving
 * input. Every wire event must reach the subscription snapshot in registration order,
 * including when multiple handlers throw or subscriptions change during delivery.
 * This covers synchronous subscriber failures, not rejected asynchronous handlers.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as logger from "@veyyon/utils/logger";
import { UI_EVENT_TYPES, type UIEvent } from "@veyyon/wire/presentation";
import { VirtualTerminal } from "../../../../hosts/terminal/engine/test/virtual-terminal";
import { Settings } from "../../src/config/settings";
import { TerminalPresentationDriver } from "../../src/modes/terminal/driver";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { testTheme } from "./helpers/presentation-theme";

const EVENTS: { [K in UIEvent["type"]]: Extract<UIEvent, { type: K }> } = {
	submit: { type: "submit", text: "draft", attachments: [] },
	interrupt: { type: "interrupt" },
	scroll: { type: "scroll", delta: -1 },
	"scroll-to-live": { type: "scroll-to-live" },
	"select-tool-approval": { type: "select-tool-approval", toolCallId: "call", approved: false, remember: false },
	"dialog-result": { type: "dialog-result", dialogId: "dialog", result: { outcome: "cancelled" } },
	command: { type: "command", command: "help", args: "" },
	resize: { type: "resize", width: 80, height: 24 },
	"composer-change": { type: "composer-change", text: "draft", cursorOffset: 5 },
	exit: { type: "exit", save: true },
};

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true, overrides: { "git.enabled": false } });
	vi.spyOn(logger, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
});

test("the event fixtures cover the wire vocabulary", () => {
	expect(Object.keys(EVENTS).sort()).toEqual([...UI_EVENT_TYPES].sort());
});

test.each([...UI_EVENT_TYPES])("all subscribers receive %s despite failures and subscription changes", kind => {
	const driver = new TerminalPresentationDriver(new VirtualTerminal(80, 24, 5_000), { theme: testTheme() });
	const event = EVENTS[kind];
	const received: { subscriber: string; event: UIEvent }[] = [];
	let removeLast: (() => void) | undefined;
	let removeLate: (() => void) | undefined;
	const removeFirst = driver.onInput(value => {
		received.push({ subscriber: "first", event: value });
		removeLast?.();
		removeLate = driver.onInput(late => received.push({ subscriber: "late", event: late }));
		throw new Error("subscriber failure");
	});
	const removeMiddle = driver.onInput(value => {
		received.push({ subscriber: "middle", event: value });
		throw "non-Error subscriber failure";
	});
	removeLast = driver.onInput(value => received.push({ subscriber: "last", event: value }));
	try {
		driver.emit(event);
		expect(received).toEqual(["first", "middle", "last"].map(subscriber => ({ subscriber, event })));
		removeFirst();
		removeMiddle();
		received.length = 0;
		driver.emit(event);
		expect(received).toEqual([{ subscriber: "late", event }]);
		removeLate?.();
		received.length = 0;
		driver.emit(event);
		expect(received).toEqual([]);
	} finally {
		driver.stop();
	}
});

test("an interrupt still reaches the session subscriber after another subscriber throws", () => {
	const term = new VirtualTerminal(80, 24, 5_000);
	const driver = new TerminalPresentationDriver(term, { theme: testTheme() });
	const received: UIEvent[] = [];
	driver.onInput(() => {
		throw new Error("subscriber failure");
	});
	driver.onInput(event => received.push(event));
	try {
		driver.start();
		term.sendInput("\x03");
		expect(received).toEqual([{ type: "interrupt" }]);
	} finally {
		driver.stop();
	}
});
