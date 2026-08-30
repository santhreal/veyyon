import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ThinkingLevel } from "@veyyon/agent-core";
import { buildModel } from "@veyyon/catalog/build";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import type { ScopedModel } from "@veyyon/coding-agent/config/model-resolver";
import { buildModelScopeNotification } from "@veyyon/coding-agent/main";
import { resetKeybindingsForTests, setKeybindings } from "@veyyon/tui";

function scopedModel(id: string): ScopedModel {
	return {
		model: buildModel({
			id,
			name: id,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		}),
		explicitThinkingLevel: false,
	};
}

describe("buildModelScopeNotification", () => {
	// The banner names a remappable chord, so it reads the process-wide manager.
	// Installed explicitly here: `getKeybindings()` hands back a bare TUI manager
	// until the app installs its own, and that one carries no `app.*` id at all,
	// so a suite reading the ambient global would pass or fail on run order.
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		resetKeybindingsForTests();
	});

	it("does not emit startup model scope chrome while startup.quiet is enabled", () => {
		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], true)).toBeNull();
	});

	it("emits the startup model scope banner when startup.quiet is disabled", () => {
		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], false)).toEqual({
			kind: "info",
			message: "Model scope: claude-sonnet-4-5 (ctrl+p to cycle)",
		});
	});
	it("includes thinking suffix only when explicitly scoped", () => {
		const withExplicit = {
			...scopedModel("claude-sonnet-4-5"),
			thinkingLevel: "high" as ThinkingLevel,
			explicitThinkingLevel: true,
		};
		expect(buildModelScopeNotification([withExplicit], false)).toEqual({
			kind: "info",
			message: "Model scope: claude-sonnet-4-5:high (ctrl+p to cycle)",
		});
	});

	it("hides the suffix when the level was filled from the global default", () => {
		// `applyRootSessionOptions` fills `sessionOptions.scopedModels[*].thinkingLevel`
		// with the global default for ctrl+p cycling — the banner must not surface that
		// default as if the user had scoped `:high`.
		const withDefault = {
			...scopedModel("claude-sonnet-4-5"),
			thinkingLevel: "high" as ThinkingLevel,
			explicitThinkingLevel: false,
		};
		expect(buildModelScopeNotification([withDefault], false)).toEqual({
			kind: "info",
			message: "Model scope: claude-sonnet-4-5 (ctrl+p to cycle)",
		});
	});

	/**
	 * The row follows the binding. Remapping the cycle gesture used to leave the
	 * banner naming `Ctrl+P`, which by then cycled nothing.
	 */
	it("names the key the user actually bound to cycling", () => {
		setKeybindings(new KeybindingsManager({ "app.model.cycleForward": "ctrl+n" }));

		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], false)?.message).toBe(
			"Model scope: claude-sonnet-4-5 (ctrl+n to cycle)",
		);
	});

	/**
	 * And with cycling unbound the whole parenthetical goes: a row that offers a
	 * gesture nobody can perform is worse than a row that offers none.
	 */
	it("drops the hint when nothing cycles models", () => {
		setKeybindings(new KeybindingsManager({ "app.model.cycleForward": [] }));

		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], false)?.message).toBe(
			"Model scope: claude-sonnet-4-5",
		);
	});
});
