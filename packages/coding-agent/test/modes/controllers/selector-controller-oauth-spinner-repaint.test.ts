/**
 * Contract: the OAuth picker's "checking" spinner (BACKLOG P6) repaints only
 * itself, never the whole UI. `showOAuthSelector` without a `providerId`
 * mounts an `OAuthSelectorComponent` over the live editor slot — which sits
 * above a possibly large transcript — and starts a validating spinner that
 * ticks every 80ms while any provider's stored auth is still being checked.
 * Before this fix that tick called the full `ui.requestRender()`, re-walking
 * the whole transcript tree on a fixed cadence purely to advance one glyph.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getOAuthProviders } from "@veyyon/pi-ai/oauth";
import { OAuthSelectorComponent } from "@veyyon/pi-coding-agent/modes/components/oauth-selector";
import { SelectorController } from "@veyyon/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/pi-coding-agent/modes/types";
import type { AuthStorage } from "@veyyon/pi-coding-agent/session/auth-storage";

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorSlot(): EditorSlot {
	return {
		children: [],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("SelectorController.showOAuthSelector spinner repaint scope", () => {
	it("ticks the validating spinner via requestComponentRender, not the full requestRender", async () => {
		vi.useFakeTimers();
		const providerId = getOAuthProviders()[0]?.id;
		expect(providerId).toBeDefined();

		const authStorage = {
			hasAuth: (id: string) => id === providerId,
			getCredentialOrigin: () => undefined,
		} as unknown as AuthStorage;
		// Never resolves, so the provider stays "checking" and the 80ms spinner
		// interval keeps ticking for the whole test.
		const getApiKeyForProvider = vi.fn(() => new Promise<string | undefined>(() => {}));

		const editorContainer = createEditorSlot();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ctx = {
			editor: { id: "editor" },
			editorContainer,
			ui: { setFocus: vi.fn(), requestRender, requestComponentRender },
			session: {
				sessionId: "session-oauth-spinner-test",
				modelRegistry: { authStorage, getApiKeyForProvider },
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		void controller.showOAuthSelector("login");
		await Promise.resolve();

		const selector = editorContainer.children[0];
		if (!(selector instanceof OAuthSelectorComponent)) {
			throw new Error("Expected the OAuth provider selector to occupy the editor slot");
		}

		// `showSelector` itself does one full render to swap the editor slot in;
		// that is expected and unrelated to the spinner cadence being asserted.
		requestRender.mockClear();
		requestComponentRender.mockClear();

		// Spinner interval is 80ms; advance several ticks.
		vi.advanceTimersByTime(400);

		expect(requestComponentRender.mock.calls.length).toBeGreaterThan(0);
		for (const call of requestComponentRender.mock.calls) {
			expect(call[0]).toBe(selector);
		}
		expect(requestRender).not.toHaveBeenCalled();

		selector.stopValidation();
	});
});
