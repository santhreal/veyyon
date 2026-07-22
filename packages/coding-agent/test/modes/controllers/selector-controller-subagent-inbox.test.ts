/**
 * `SelectorController.showAgentHub` routing under the experimental
 * `display.subagentInbox` flag. The same open gesture must raise the
 * opencode-style split inbox when the flag is on and the unchanged modal Agent
 * Hub when it is off — so this suite mounts the controller with a minimal
 * context, opens the hub through the real method, and asserts the EXACT
 * component type handed to the editor slot on each side of the flag. If the
 * branch ever inverts or the flag is ignored, one of these fails.
 *
 * The flag is read from the process-global settings singleton (not ctx), so the
 * test toggles it there; the global agent registry / IRC bus are reset each case
 * so a mounted overlay never leaks state into the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import { AgentHubOverlayComponent } from "@veyyon/coding-agent/modes/components/agent-hub";
import { SubagentInboxComponent } from "@veyyon/coding-agent/modes/components/subagent-inbox";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";

interface Mounted {
	value: unknown;
}

/** A context stub carrying only what `showAgentHub` and both overlays touch. */
function makeCtx(mounted: Mounted): InteractiveModeContext {
	return {
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((c: unknown) => {
				mounted.value = c;
			}),
			children: [],
		},
		editor: {},
		keybindings: { getKeys: () => ["ctrl+o"] },
		collabGuest: undefined,
		focusAgentSession: vi.fn(),
		session: { getToolByName: () => undefined, extensionRunner: undefined },
		sessionManager: { getCwd: () => "/tmp", getSessionFile: () => null },
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
	} as unknown as InteractiveModeContext;
}

/** A no-op observers registry — both overlays subscribe to its onChange. */
const observers = { onChange: () => () => {} } as never;

describe("SelectorController.showAgentHub — display.subagentInbox routing", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true });
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("mounts the experimental SubagentInboxComponent when the flag is ON", () => {
		settings.set("display.subagentInbox", true);
		const mounted: Mounted = { value: undefined };
		const controller = new SelectorController(makeCtx(mounted));

		controller.showAgentHub(observers);

		expect(mounted.value).toBeInstanceOf(SubagentInboxComponent);
		expect(mounted.value).not.toBeInstanceOf(AgentHubOverlayComponent);
		(mounted.value as SubagentInboxComponent).dispose();
	});

	it("mounts the unchanged AgentHubOverlayComponent when the flag is OFF (default)", () => {
		settings.set("display.subagentInbox", false);
		const mounted: Mounted = { value: undefined };
		const controller = new SelectorController(makeCtx(mounted));

		controller.showAgentHub(observers);

		expect(mounted.value).toBeInstanceOf(AgentHubOverlayComponent);
		expect(mounted.value).not.toBeInstanceOf(SubagentInboxComponent);
		(mounted.value as AgentHubOverlayComponent).dispose();
	});

	it("defaults to the modal hub — an untouched flag routes to AgentHubOverlayComponent", () => {
		// No `settings.set` at all: the shipped default must be the hub, so the
		// experimental surface can never appear without an explicit opt-in.
		const mounted: Mounted = { value: undefined };
		const controller = new SelectorController(makeCtx(mounted));

		controller.showAgentHub(observers);

		expect(mounted.value).toBeInstanceOf(AgentHubOverlayComponent);
		(mounted.value as AgentHubOverlayComponent).dispose();
	});
});
