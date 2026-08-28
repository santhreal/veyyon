/**
 * The settings screen applies a prompt gate by WRITING it, and says so when a flip cannot land.
 *
 * WHY THIS SUITE EXISTS. The controller carried a `case` per setting deciding which flips
 * rebuild the system prompt, and it had two of the nine. Flipping `subagent.batch` or
 * `tools.format` changed the setting and left the model reading a prompt that described the
 * previous configuration, with nothing logged, until an unrelated rebuild happened to fire.
 *
 * WHERE THE REBUILD LIVES NOW, AND WHY NOT HERE. Reading the registry fixed the list but left
 * the trigger beside ONE writer. `AgentSession` also rebuilt, off the settings store, for a
 * second list of eight paths — the trigger every other writer reaches (a slash command, an SDK
 * or ACP host, a plugin). Five paths were in both, so a flip through this screen rebuilt twice;
 * six live gates were in the session's list not at all, so writing one anywhere but here did
 * nothing. The session's listener is the single trigger now, asking the same registry, and this
 * controller must NOT rebuild: `test/a-settings-write-rebuilds-the-prompt-it-changes.test.ts`
 * drives real writes at a real session and owns that half.
 *
 * What is still this screen's own contract is the frozen half. A gate this session captured at
 * startup cannot follow a flip, and the settings screen shows the new value either way, so
 * without the notice an operator has no way to distinguish an applied change from one that did
 * nothing at all. Nothing outside a UI can say that, so nothing outside a UI can test it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
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
	it.each([...LIVE_PROMPT_GATE_SETTINGS])("does not rebuild the prompt itself for %s", setting => {
		// The WRITE rebuilds, in the session's effective-setting listener. A rebuild here as well
		// would be the second owner back: two rebuilds for one flip, and a trigger that still only
		// covers flips arriving through this screen.
		const { controller, refreshBaseSystemPrompt } = harness();

		controller.handleSettingChange(setting, Settings.instance.get(setting as never));

		expect(refreshBaseSystemPrompt, `${setting} rebuilt from the UI as well as the write`).not.toHaveBeenCalled();
	});

	it("says nothing about a live gate, which needs no notice", () => {
		// The warning is reserved for a flip that cannot land. Warning on one that did is how the
		// real notice gets ignored.
		const { controller, showWarning } = harness();

		controller.handleSettingChange("subagent.batch", true);

		expect(showWarning).not.toHaveBeenCalled();
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
