/**
 * `accounts.loadBalancing` is reachable from two surfaces, and both of them must be the same knob.
 *
 * WHY THIS SUITE EXISTS. The account card carries the toggle because the setting answers the question
 * the usage bars below it provoke: what happens when this account runs out. That makes the card a
 * SECOND writer of a settings key whose first writer is the settings screen, and a second writer is
 * exactly where a knob stops being one knob. Every existing card test stubs
 * `onToggleLoadBalancing: () => false`, so the production wiring in
 * `SelectorController.showAccountManager` (the settings write, and the read-back that decides what the
 * chip then claims) was asserted nowhere: the card could have painted `balancing on` over a config
 * that still said off, which is worse than no toggle at all, because the operator would believe a
 * second subscription was in play when it was not, or believe it was not when it was.
 *
 * These cases drive the REAL controller through the real component: the press goes into
 * `AccountManagerComponent.handleInput`, the callback is the production closure, and the value is read
 * back out of the same `Settings` object the settings screen reads. The read-back is given its own
 * negative control, because a write that is refused or coerced is a real outcome (a validator, a
 * read-only config layer), and the chip's honesty in that case is the whole reason the callback
 * returns the stored value rather than the value it just tried to write.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

/**
 * A real credential store, not a stubbed `AuthStorage`.
 *
 * The inventory the card renders from calls a dozen storage methods (routing, selection, names,
 * origin, health), and a hand-written fake of that surface is a second implementation that drifts:
 * the first draft of this suite failed on `sessionCredentialRouting` alone, which is the fake telling
 * on itself. One sqlite-backed account is cheaper than the fake and cannot go stale.
 */
let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-balancing-card-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
	// The card probes credential health when it opens, which is an HTTP call per stored
	// credential. A suite that made it would be neither hermetic nor fast: the fake token here
	// can only produce a network error after a timeout, and the balancing contract has nothing to
	// do with health. Stubbed on the real instance rather than by faking the whole storage.
	vi.spyOn(authStorage, "checkCredentials").mockResolvedValue([]);
	await authStorage.set("anthropic", [
		{
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 8 * 60 * 60_000,
			accountId: "acct-one",
			email: "one@example.com",
		},
	]);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

interface Harness {
	/** The card the controller actually mounted, so a press goes through production input handling. */
	readonly card: AccountManagerComponent;
	readonly settings: Settings;
	/** The card body with ANSI stripped, joined, for chip and scope-line assertions. */
	readonly text: () => string;
	/** Every status line the press produced, which is where the toggle's receipt goes. */
	readonly statuses: string[];
}

async function openCard(initial: boolean): Promise<Harness> {
	// The GLOBAL store, not a private isolated one. The settings screen reads the singleton
	// (`Settings.instance`), so a card driven off a side instance could agree with itself while the two
	// surfaces disagreed, which is the exact failure the last case here exists to catch.
	const settings = Settings.instance;
	settings.set("accounts.loadBalancing", initial);
	const statuses: string[] = [];

	let mounted: AccountManagerComponent | undefined;
	const ctx = {
		editorContainer: { children: [], clear: () => {}, addChild: () => {} },
		editor: {},
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			showOverlay: vi.fn((component: unknown) => {
				mounted = component as AccountManagerComponent;
				return { hide: vi.fn() };
			}),
		},
		session: {
			sessionId: "session-balancing-test",
			settings,
			modelRegistry: { authStorage, refresh: vi.fn(async () => undefined) },
			// The card probes health and usage on open. Both are network calls; the balancing
			// contract is about the config write, so they answer empty rather than being reached.
			fetchUsageReports: async () => [],
		},
		showStatus: vi.fn((message: string) => {
			statuses.push(message);
		}),
		showWarning: vi.fn(),
		showError: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	await new SelectorController(ctx).showAccountManager("anthropic");
	if (!(mounted instanceof AccountManagerComponent)) {
		throw new Error("the controller mounted no account manager card");
	}
	const card = mounted;
	return {
		card,
		statuses,
		settings,
		// Wide enough that the scope line is not truncated: the sidebar takes a fixed column, and at
		// 120 the sentence that names what the toggle governs is cut mid-word.
		text: () =>
			card
				.render(200)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
	};
}

describe("the account card's balancing toggle", () => {
	/**
	 * The press has to reach the config, not just the chip. A card-local boolean would satisfy every
	 * on-screen assertion and change nothing about what the next session does when an account runs out.
	 */
	it("writes the setting and paints what it wrote", async () => {
		const harness = await openCard(false);
		expect(harness.text()).toContain("b balancing off");
		expect(harness.text()).toContain("quota load balancing off");

		harness.card.handleInput("b");

		expect(harness.settings.get("accounts.loadBalancing")).toBe(true);
		expect(harness.text()).toContain("b balancing on");
		expect(harness.text()).toContain("quota load balancing on");
	});

	/** A toggle that only turns on is a trap: the operator cannot take back the subscription. */
	it("turns it back off", async () => {
		const harness = await openCard(true);
		expect(harness.text()).toContain("b balancing on");

		harness.card.handleInput("b");

		expect(harness.settings.get("accounts.loadBalancing")).toBe(false);
		expect(harness.text()).toContain("b balancing off");
	});

	/**
	 * The card opens honest. It is handed the current value rather than assuming the default, so a
	 * session started with balancing already on cannot show a chip that invites the operator to turn on
	 * what is already running.
	 */
	it("opens on the stored value rather than the default", async () => {
		expect((await openCard(true)).text()).toContain("b balancing on");
		expect((await openCard(false)).text()).toContain("b balancing off");
	});

	/**
	 * The negative control for the read-back. When the write does not stick, the chip must keep saying
	 * off: this is the one case where trusting the value it tried to write would put a claim about a
	 * second subscription on screen with nothing behind it.
	 */
	it("keeps the chip on the stored value when the write does not stick", async () => {
		const harness = await openCard(false);
		// Only this spy is restored, and by handle. `vi.restoreAllMocks()` here would also drop the
		// health-probe stub installed for the whole file, so the cases after this one would start
		// making real HTTP calls and slow down for a reason nothing in them explains.
		const refusedWrite = vi.spyOn(harness.settings, "set").mockImplementation(() => {});
		try {
			harness.card.handleInput("b");

			expect(harness.settings.get("accounts.loadBalancing")).toBe(false);
			expect(harness.text()).toContain("b balancing off");
			expect(harness.text()).not.toContain("b balancing on");
		} finally {
			refusedWrite.mockRestore();
		}
	});

	/**
	 * One knob, two surfaces. The settings screen renders from the same key the card writes, so a
	 * press on the card is visible in `/settings` without a reload, and a future second key for "the
	 * card's own balancing" would turn this red rather than shipping two answers to one question.
	 */
	it("is the same key the settings screen renders", async () => {
		const harness = await openCard(false);
		harness.card.handleInput("b");

		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: ["default"],
				providers: ["anthropic"],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		for (const character of "balancing") selector.handleInput(character);
		const screen = selector
			.render(100)
			.map(line => stripVTControlCharacters(line))
			.join("\n");

		expect(screen).toContain("Account Load Balancing");
		expect(screen).toContain("true");
	});

	/**
	 * A two-word chip is a thin receipt for a PERMANENT change. The press wrote a value that outlives
	 * the session, so the receipt says what the new state does and that it was saved; a repaint alone
	 * leaves the operator to infer both, and the thing they most need to know (this survives the
	 * restart) is the part a repaint cannot express.
	 */
	it("says what the new state does and that it persists", async () => {
		const harness = await openCard(false);

		harness.card.handleInput("b");

		const receipt = harness.statuses.at(-1) ?? "";
		expect(receipt).toContain("Account load balancing on");
		expect(receipt).toContain("moves to another account of the same provider");
		expect(receipt).toContain("Saved for this profile.");

		harness.card.handleInput("b");

		const offReceipt = harness.statuses.at(-1) ?? "";
		expect(offReceipt).toContain("Account load balancing off");
		expect(offReceipt).toContain("waits for its own quota window");
		expect(offReceipt).toContain("Saved for this profile.");
	});

	/**
	 * The receipt comes from the STORED value, like the chip. A sentence built from the value the
	 * press tried to write would announce a saved change that was refused, which is the same lie as a
	 * chip painting `on` over a config that says off, in the surface the operator is more likely to
	 * read.
	 */
	it("reports the stored value when the write does not stick", async () => {
		const harness = await openCard(false);
		const refusedWrite = vi.spyOn(harness.settings, "set").mockImplementation(() => {});
		try {
			harness.card.handleInput("b");

			expect(harness.statuses.at(-1) ?? "").toContain("Account load balancing off");
		} finally {
			refusedWrite.mockRestore();
		}
	});
});
