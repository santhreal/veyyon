/**
 * A fullscreen overlay must not repaint the transcript on a cadence (BACKLOG P6).
 *
 * THE CLASS. An overlay that animates or polls sits above a transcript that can be thousands of
 * lines long. Advancing one glyph through `ui.requestRender()` re-walks that whole tree on a fixed
 * interval, so the cost of a spinner scales with the session rather than with the overlay. The
 * defect was first found in the OAuth provider picker's "checking" spinner; the fix was to hand
 * every overlay a component-scoped repaint (`ui.requestComponentRender(component)`) and to keep the
 * full render for state changes only. `/login` with no provider now opens the ACCOUNT CARD, so the
 * card is the surface that inherits the guarantee, and the picker it replaced is mounted nowhere.
 *
 * WHAT THIS SUITE PINS.
 *
 *  1. `showLogin()` with no provider mounts the account card as a fullscreen overlay.
 *  2. Once the card is up and its probes have landed, TIME ALONE produces no repaints at all: no
 *     `requestRender`, no `requestComponentRender`. A cadence that ticks the whole UI and a cadence
 *     that ticks only the card are both wrong here, because nothing is animating.
 *  3. When the card DOES want a repaint, it gets a component-scoped one. Driven by real pointer
 *     motion across the rendered frame until the pointer crosses a footer chip, which is the card's
 *     cheapest and most frequent repaint: a hover that re-rendered the transcript would be the
 *     original defect with a mouse instead of a timer.
 *
 * WHAT IT DOES NOT CATCH. The card's frame is not asserted (that is
 * `test/modes/components/account-manager.test.ts`), and a repaint triggered by a real state change
 * is expected and deliberately not forbidden: `reload()` after a pin, a rename or a logout renders
 * the whole UI once, on purpose, because the rows underneath the overlay changed too.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const FRAME_WIDTH = 120;

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-overlay-repaint-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
	await authStorage.set("anthropic", [
		{
			type: "oauth",
			access: "access-repaint",
			refresh: "refresh-repaint",
			expires: Date.now() + 8 * 60 * 60_000,
			accountId: "acct-repaint",
			email: "repaint@example.com",
		},
	]);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Mounted {
	readonly cards: AccountManagerComponent[];
	readonly card: AccountManagerComponent;
	readonly requestRender: ReturnType<typeof vi.fn<() => void>>;
	readonly requestComponentRender: ReturnType<typeof vi.fn<(component: unknown) => void>>;
}

async function mountCard(): Promise<Mounted> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	// A health probe is an HTTP round trip per credential and says nothing about repaint scope.
	vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);

	const cards: AccountManagerComponent[] = [];
	const requestRender = vi.fn(() => undefined);
	const requestComponentRender = vi.fn((_component: unknown) => undefined);
	const ctx = {
		editor: {},
		editorContainer: { children: [], clear: () => {}, addChild: () => {} },
		ui: {
			setFocus: vi.fn(),
			requestRender,
			requestComponentRender,
			showOverlay: vi.fn((component: unknown) => {
				if (component instanceof AccountManagerComponent) cards.push(component);
				return { hide: vi.fn() };
			}),
		},
		session: {
			sessionId: "session-overlay-repaint",
			settings: Settings.instance,
			modelRegistry: { authStorage: storage, refresh: vi.fn(async () => undefined) },
			fetchUsageReports: async () => [],
		},
		present: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	await new SelectorController(ctx).showLogin();
	const card = cards[cards.length - 1];
	if (!card) throw new Error("no account card was mounted");
	return { cards, card, requestRender, requestComponentRender };
}

/** Pointer motion at a 1-based terminal cell, as a terminal reports it. */
function motion(col: number, row: number): string {
	return `\x1b[<35;${col};${row}M`;
}

describe("the account card is the overlay /login opens", () => {
	it("mounts the card rather than a provider picker", async () => {
		const mounted = await mountCard();

		expect(mounted.cards).toHaveLength(1);
	});

	/**
	 * Nothing is animating once the probes have landed, so nothing may repaint. This is the assertion
	 * the original spinner defect fails: a fixed interval behind the overlay shows up here as calls
	 * that no state change asked for.
	 */
	it("produces no repaint at all from the passage of time", async () => {
		const mounted = await mountCard();
		mounted.card.render(FRAME_WIDTH);
		mounted.requestRender.mockClear();
		mounted.requestComponentRender.mockClear();

		await sleep(400);

		expect(mounted.requestRender).not.toHaveBeenCalled();
		expect(mounted.requestComponentRender).not.toHaveBeenCalled();
	});

	it("repaints a hover through the component-scoped channel, never the full render", async () => {
		const mounted = await mountCard();
		const height = mounted.card.render(FRAME_WIDTH).length;
		mounted.requestRender.mockClear();
		mounted.requestComponentRender.mockClear();

		// The footer chips are on the card's last rows; sweep upward from the bottom until the
		// pointer crosses one. Motion is the safe event to sweep with: it can only move a hover, and
		// unlike a click it can neither select a provider nor close the card.
		for (let row = height; row > 0 && mounted.requestComponentRender.mock.calls.length === 0; row--) {
			for (let col = 1; col <= FRAME_WIDTH; col++) {
				mounted.card.handleInput(motion(col, row));
				if (mounted.requestComponentRender.mock.calls.length > 0) break;
			}
		}

		expect(mounted.requestComponentRender).toHaveBeenCalled();
		for (const call of mounted.requestComponentRender.mock.calls) {
			expect(call[0]).toBe(mounted.card);
		}
		expect(mounted.requestRender).not.toHaveBeenCalled();
	});
});
