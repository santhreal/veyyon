/**
 * `accounts.loadBalancing` has ONE writer, and the account card is not it.
 *
 * WHY THIS SUITE EXISTS. The card used to carry a `b` toggle for this key, so a settings value
 * declared in `settings-domains/providers.ts` and edited in Settings -> Providers -> Accounts had a
 * second writer with its own read-back, its own chip and its own status line. Two writers is where a
 * knob stops being one knob: the card could paint a state the settings screen disagreed with, and the
 * key also cost the sidebar a letter that the filter then wanted. The toggle is gone; the card still
 * NAMES the value, because what happens when the account on screen runs out is the question the usage
 * bars below it provoke.
 *
 * The class this closes is "a surface that displays a setting starts editing it". The guard is a
 * negative: pressing the old key changes neither the config nor the line that reports it. It runs
 * against the real controller, the real component and the real `Settings` singleton the settings
 * screen reads, so a card driven off a side instance cannot agree with itself while the two surfaces
 * disagree.
 *
 * What it does NOT catch: nothing here drives the settings screen's own write path, which its own
 * suites own; this asserts that the screen renders the same key and that the card follows it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/terminal/components/account/account-manager";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

/**
 * A real credential store, not a stubbed `AuthStorage`.
 *
 * The inventory the card renders from calls a dozen storage methods (routing, selection, names,
 * origin, health), and a hand-written fake of that surface is a second implementation that drifts.
 * One sqlite-backed account is cheaper than the fake and cannot go stale.
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
	/** The card body with ANSI stripped, joined, for scope-line assertions. */
	readonly text: () => string;
	/** Every status line the card produced, which is where a write's receipt would go. */
	readonly statuses: string[];
}

async function openCard(initial: boolean): Promise<Harness> {
	// The GLOBAL store, not a private isolated one. The settings screen reads the singleton
	// (`Settings.instance`), so a card driven off a side instance could agree with itself while the
	// two surfaces disagreed, which is the exact failure the last case here exists to catch.
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
			// The card probes health and usage on open. Both are network calls; this contract is
			// about the config, so they answer empty rather than being reached.
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
		// 120 the sentence that names what the setting governs is cut mid-word.
		text: () =>
			card
				.render(200)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
	};
}

describe("the accounts card and the balancing setting", () => {
	/**
	 * The card opens honest. It is handed the current value rather than assuming the default, so a
	 * session started with balancing already on does not report that it is off.
	 */
	it("names the stored value rather than the default", async () => {
		expect((await openCard(true)).text()).toContain("quota load balancing on");
		expect((await openCard(false)).text()).toContain("quota load balancing off");
	});

	/**
	 * The guard. `b` was the toggle, and every letter the card does not claim now belongs to the
	 * provider filter, so the failure mode of a re-added writer is silent: the key would work again
	 * and the settings screen would stop being the only place the value changes.
	 */
	it("does not write the setting when the old toggle key is pressed", async () => {
		const harness = await openCard(false);

		harness.card.handleInput("b");

		expect(harness.settings.get("accounts.loadBalancing")).toBe(false);
		expect(harness.text()).toContain("quota load balancing off");
		expect(harness.statuses).toEqual([]);
	});

	/** And the same key with the value the other way round, so neither direction has a writer. */
	it("does not clear the setting when the old toggle key is pressed", async () => {
		const harness = await openCard(true);

		harness.card.handleInput("b");

		expect(harness.settings.get("accounts.loadBalancing")).toBe(true);
		expect(harness.text()).toContain("quota load balancing on");
		expect(harness.statuses).toEqual([]);
	});

	/** The footer offers no balancing control, so nothing on screen advertises what the card cannot do. */
	it("offers no balancing chip and advertises the filter instead", async () => {
		const harness = await openCard(true);

		expect(harness.text()).not.toContain("b balancing");
		expect(harness.text()).toContain("ctrl+s search");
	});

	/**
	 * One knob, two surfaces. The settings screen renders the same key the card reports, and a change
	 * made through the settings object reaches a freshly opened card, so the two cannot drift.
	 */
	it("follows the settings screen, which is the key's one writer", async () => {
		const before = await openCard(false);
		expect(before.text()).toContain("quota load balancing off");

		before.settings.set("accounts.loadBalancing", true);

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
		expect((await openCard(true)).text()).toContain("quota load balancing on");
	});
});
