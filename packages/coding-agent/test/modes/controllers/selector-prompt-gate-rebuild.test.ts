/**
 * Flipping a setting the prompt gates on rebuilds the prompt, and flipping a frozen one says so.
 *
 * WHY THIS SUITE EXISTS. `prompt-gate-registry.test.ts` proves the registry is one complete
 * list and that the controller reads it. That is a check on the source text, and a check on
 * source text cannot tell you the rebuild actually fires: the call could be inside a branch
 * that never runs, or after an early `return` for a settings prefix.
 *
 * The bug this locks out was exactly a wiring failure, not a bad list. The controller carried
 * a `case` per setting deciding which flips rebuild the system prompt, and it had two of the
 * nine. Flipping `subagent.batch` or `tools.format` changed the setting and left the model
 * reading a prompt that described the previous configuration, with nothing logged, until an
 * unrelated rebuild happened to fire. So these tests drive the real
 * `SelectorController.handleSettingChange` and assert what reached the session.
 *
 * The frozen half matters for the same reason. A gate this session captured at startup cannot
 * follow a flip, and the settings screen shows the new value either way, so an operator had no
 * way to distinguish an applied change from one that did nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import {
	FROZEN_PROMPT_GATE_SETTINGS,
	LIVE_PROMPT_GATE_SETTINGS,
	promptGateFor,
} from "@veyyon/coding-agent/system-prompt-builder/gate-registry";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

interface Harness {
	readonly controller: SelectorController;
	readonly refreshBaseSystemPrompt: ReturnType<typeof vi.fn>;
	readonly showWarning: ReturnType<typeof vi.fn>;
	readonly showError: ReturnType<typeof vi.fn>;
}

/**
 * A controller with just enough context to take a setting change.
 *
 * Only the three surfaces a gate flip can reach are stubbed. Anything else the switch touches
 * for a given setting is out of scope here and covered by `selector-settings-side-effects`.
 */
function harness(): Harness {
	const refreshBaseSystemPrompt = vi.fn(() => Promise.resolve([]));
	const showWarning = vi.fn();
	const showError = vi.fn();
	const controller = new SelectorController({
		session: { refreshBaseSystemPrompt },
		showWarning,
		showError,
		ui: { invalidate: vi.fn(), requestRender: vi.fn(), resetDisplay: vi.fn() },
		rebuildChatFromMessages: vi.fn(),
		statusLine: { invalidate: vi.fn(), updateSettings: vi.fn() },
	} as unknown as InteractiveModeContext);
	return { controller, refreshBaseSystemPrompt, showWarning, showError };
}

describe("flipping a live prompt gate", () => {
	it.each([...LIVE_PROMPT_GATE_SETTINGS])("rebuilds the system prompt for %s", setting => {
		// Every live gate, driven individually. The seven that used to be missing are in here,
		// and so are the two that worked, so a change that fixes one by breaking another fails.
		const { controller, refreshBaseSystemPrompt } = harness();

		controller.handleSettingChange(setting, Settings.instance.get(setting as never));

		expect(refreshBaseSystemPrompt, `${setting} did not rebuild the prompt`).toHaveBeenCalledTimes(1);
	});

	it("names the setting in the rebuild reason, so a prompt rebuild can be traced to a flip", () => {
		// The reason string reaches the session's rebuild log. "unspecified" would leave an
		// operator debugging a prompt change with no way to tell what caused it.
		const { controller, refreshBaseSystemPrompt } = harness();

		controller.handleSettingChange("subagent.batch", true);

		expect(refreshBaseSystemPrompt).toHaveBeenCalledWith("setting:subagent.batch");
	});

	it("rebuilds exactly once, not once per owner of the setting", () => {
		// `tui.renderMermaid` also has TUI side effects in the switch below the gate check, and
		// it used to do its own rebuild there. Two rebuilds would mean the hand-written list is
		// back alongside the registry.
		const { controller, refreshBaseSystemPrompt } = harness();

		controller.handleSettingChange("tui.renderMermaid", false);

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	it("still performs the setting's other side effects", () => {
		// The gate check runs before the switch and must not swallow it. `tui.renderMermaid`
		// switches the renderer and retires blocks already committed to scrollback.
		const rebuildChatFromMessages = vi.fn();
		const resetDisplay = vi.fn();
		const controller = new SelectorController({
			session: { refreshBaseSystemPrompt: vi.fn(() => Promise.resolve([])) },
			showWarning: vi.fn(),
			showError: vi.fn(),
			ui: { invalidate: vi.fn(), requestRender: vi.fn(), resetDisplay },
			rebuildChatFromMessages,
			statusLine: { invalidate: vi.fn(), updateSettings: vi.fn() },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("tui.renderMermaid", false);

		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("surfaces a failed rebuild instead of dropping the rejection", () => {
		// The rebuild is fire-and-forget. Without the catch a failure would be an unhandled
		// rejection and the operator would see a saved setting and an unchanged prompt.
		const refreshBaseSystemPrompt = vi.fn(() => Promise.reject(new Error("template unreadable")));
		const showError = vi.fn();
		const controller = new SelectorController({
			session: { refreshBaseSystemPrompt },
			showWarning: vi.fn(),
			showError,
			ui: { invalidate: vi.fn(), requestRender: vi.fn(), resetDisplay: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn(), updateSettings: vi.fn() },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("personality", "none");

		return Bun.sleep(0).then(() => {
			expect(showError).toHaveBeenCalledTimes(1);
			expect(String(showError.mock.calls[0][0])).toContain("personality");
			expect(String(showError.mock.calls[0][0])).toContain("template unreadable");
		});
	});
});

describe("flipping a frozen prompt gate", () => {
	it.each([...FROZEN_PROMPT_GATE_SETTINGS])("does not claim to have applied %s", setting => {
		const { controller, refreshBaseSystemPrompt } = harness();

		controller.handleSettingChange(setting, Settings.instance.get(setting as never));

		// A rebuild here would be worse than doing nothing: it would re-read the same captured
		// value and report success for a change that did not happen.
		expect(refreshBaseSystemPrompt, `${setting} is frozen but rebuilt the prompt`).not.toHaveBeenCalled();
	});

	it.each([...FROZEN_PROMPT_GATE_SETTINGS])("tells the operator %s applies next session", setting => {
		const { controller, showWarning } = harness();

		controller.handleSettingChange(setting, Settings.instance.get(setting as never));

		expect(showWarning, `${setting} flipped in silence`).toHaveBeenCalledTimes(1);
		const message = String(showWarning.mock.calls[0][0]);
		expect(message).toContain(setting);
		expect(message).toContain("next session");
		expect(message).toContain(promptGateFor(setting)?.renders ?? "");
	});
});

describe("flipping a setting the prompt does not gate on", () => {
	it("neither rebuilds the prompt nor warns", () => {
		// A false warning on every unrelated toggle is how a real one gets ignored. `theme`
		// changes the TUI and not one byte of the prompt.
		const { controller, refreshBaseSystemPrompt, showWarning } = harness();

		controller.handleSettingChange("tui.tight", true);

		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("leaves the discovery-provider path alone, which returns before the gate check", () => {
		// `discovery.*` toggles are handled by an early return above the gate check. They change
		// the tool set rather than a prompt gate, and reaching them would mean the gate check
		// moved above that return.
		const { controller, refreshBaseSystemPrompt, showWarning } = harness();

		controller.handleSettingChange("discovery.some-provider", true);

		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(showWarning).not.toHaveBeenCalled();
	});
});
