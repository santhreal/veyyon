import { beforeAll, describe, expect, it, vi } from "bun:test";
import { LogoutAccountSelectorComponent } from "@veyyon/coding-agent/modes/components/logout-account-selector";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AuthStorage, StoredAuthCredential } from "@veyyon/coding-agent/session/auth-storage";

interface TestEditorContainer {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorContainer(): TestEditorContainer {
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

function createOverlayHost() {
	let overlaid: unknown;
	const showOverlay = vi.fn((component: unknown) => {
		overlaid = component;
		return { hide: vi.fn() };
	});
	return { showOverlay, getOverlaid: () => overlaid };
}

function createStoredCredential(id: number, email: string, accountId: string): StoredAuthCredential {
	return {
		id,
		provider: "anthropic",
		disabledCause: null,
		credential: {
			type: "oauth",
			access: `access-${id}`,
			refresh: `refresh-${id}`,
			expires: Date.now() + 60_000,
			email,
			accountId,
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController logout", () => {
	it("opens an account picker and removes only the selected credential", async () => {
		const editorContainer = createEditorContainer();
		const credentials = [
			createStoredCredential(21, "a@example.com", "acct-a"),
			createStoredCredential(22, "b@example.com", "acct-b"),
		];
		const removeCredential = vi.fn(async (_provider: string, credentialId: number) => {
			const index = credentials.findIndex(row => row.id === credentialId);
			if (index === -1) return false;
			credentials.splice(index, 1);
			return true;
		});
		const authStorage = {
			reload: vi.fn(async () => undefined),
			listStoredCredentials: (_provider?: string) => credentials,
			getOAuthAccountIdentity: (_provider: string, _sessionId?: string) => ({ accountId: "acct-a" }),
			getCredentialOrigin: (_provider: string) => ({ kind: "oauth" }),
			describeCredentialSource: (_provider: string, _sessionId?: string) => undefined,
			removeCredential,
		} as unknown as AuthStorage;
		const refresh = vi.fn(async () => undefined);
		const presented = Promise.withResolvers<void>();
		const overlayHost = createOverlayHost();
		const ctx = {
			editorContainer,
			editor: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				showOverlay: overlayHost.showOverlay,
			},
			session: {
				sessionId: "session-logout-test",
				modelRegistry: {
					authStorage,
					refresh,
				},
			},
			showError: vi.fn(),
			present: vi.fn(() => {
				presented.resolve();
			}),
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		await controller.showOAuthSelector("logout", "anthropic");

		const selector = overlayHost.getOverlaid();
		if (!(selector instanceof LogoutAccountSelectorComponent)) {
			throw new Error("Expected logout account selector");
		}
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		await presented.promise;

		expect(removeCredential).toHaveBeenCalledWith("anthropic", 22);
		expect(credentials.map(row => row.id)).toEqual([21]);
		expect(refresh).toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.present).toHaveBeenCalled();
	});
});
