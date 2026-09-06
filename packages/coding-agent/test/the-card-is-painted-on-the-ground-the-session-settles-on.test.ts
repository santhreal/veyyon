// WHY THIS SUITE EXISTS (THE-CARD-IS-PAINTED-ON-THE-GROUND-THE-SESSION-SETTLES-ON).
//
// The defect: one line on a settled screen changed shade under the operator, about half a second
// after the launch card appeared. Measured on a pty that answers OSC 11 the way a terminal does
// (`.internal/ground-handoff.ts`, 120x30, `#0d1117` ground): the hairline above the composer was
// drawn from the static `borderMuted` token, `#202329`, at 46ms, and restyled to the ground-derived
// `#2a2e33` at 615ms. Nothing else on the frame moved, which is what made it read as a glitch
// rather than as the session arriving.
//
// Two causes, one behind the other. `ui.start()` is what SENDS the OSC 11 query, so no answer can
// exist when the card is painted; and nothing consumed the answer that did arrive until the mode
// subscribed at mount. So the card had no ground, drew every ground-relative color from its
// fallback token, and the mode's subscription restyled the lot on a screen the operator had already
// been looking at for half a second.
//
// The class this closes is not "the hairline". It is "the card resolves a color against a different
// ground from the one the session settles on". Every such color -- the hairline, the composer
// outline, the transcript rules, a band mixed out of the ground, anything added later -- resolves
// through ONE owner, `getVisibleGround()`, so the invariant is asserted at that owner and at the
// bytes on the wire rather than once per component:
//
//   1. The ground is known BEFORE the first paint, from what this terminal last reported.
//   2. A report that confirms the recorded ground writes nothing at all.
//   3. A report that contradicts it WINS, on the card's own frame rather than at mount.
//   4. The session records the report, or every launch is the first one and the seed is inert.
//   5. Mounting the session does not drop the seeded ground back to the fallback token.
//
// The suite drives the production path: the real recorder, the real `paintFirstFrame`, a real
// `InteractiveMode` over a real `TUI` on a real `ProcessTerminal`, and the terminal's own OSC 11
// parser fed through `process.stdin`. Only stdin and stdout are doubled, because there is no
// terminal in a test.
//
// WHAT IT DOES NOT CATCH: a component that reaches past `getVisibleGround()` for a ground of its
// own -- nothing here can see a caller that never calls the owner. It says nothing about how the
// shade looks to an eye, which is what the recorded proof is for, and nothing about the first
// launch in a terminal that has never reported: that one has no recorded ground by definition, and
// the third test below is what it does instead.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { readLaunchFacts, recordLaunchFacts, resetLaunchFactsForTest } from "@veyyon/coding-agent/modes/launch-facts";
import { paintFirstFrame, takeFirstFrame } from "@veyyon/coding-agent/modes/terminal/first-frame";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	getVisibleGround,
	groundHairlineHex,
	groundTintFgAnsi,
	resetGroundTintsForTest,
	setDetectedTerminalGround,
} from "@veyyon/coding-agent/theme/ground-tints";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setTerminalHeadless, TempDir } from "@veyyon/utils";
import { OSC11_RESET_BACKGROUND_SEQUENCE, osc11SetBackgroundSequence } from "@veyyon/utils/paint-ground";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/** A ground a real terminal reports, and nothing like the theme's declared black. */
const REPORTED = "#0d1117";
/** A second one, for a launch in a terminal the record no longer describes. */
const STALE = "#2b2b2b";

/** The hairline foreground each ground derives, as the one owner derives it. */
const TINT: Record<string, string> = {};

/** Titanium's declared ground, and the sequence that paints it. */
const THEME_GROUND = "#000000";
const THEME_GROUND_PAINT = osc11SetBackgroundSequence(THEME_GROUND) ?? "";

/** The OSC 11 answer for `#rrggbb`, in the four-digit-per-channel form xterm sends. */
function osc11(hex: string): string {
	const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
	return `\x1b]11;rgb:${r}${r}/${g}${g}/${b}${b}\x07`;
}

let isolated: IsolatedConfigRoot;
let previousHeadless: boolean;
/** Every byte the engine hands the terminal, in order. */
let writes: string[];
/** Everything a test opened, closed in reverse however the test ended. */
const opened: (() => Promise<void> | void)[] = [];

useTruecolorTheme("titanium");

beforeAll(async () => {
	await initTheme();
	// Taken from the owner rather than restated: the mix that turns a ground into a hairline belongs
	// to `ground-tints`, and a suite that recomputes it here would agree with itself while
	// disagreeing with the product.
	for (const hex of [REPORTED, STALE]) {
		setDetectedTerminalGround(hex);
		const tint = groundTintFgAnsi(groundHairlineHex(), true);
		if (tint === undefined) throw new Error(`no derived hairline tint for ${hex}`);
		TINT[hex] = tint;
	}
	resetGroundTintsForTest();
	if (TINT[REPORTED] === TINT[STALE]) throw new Error("the two grounds derive one tint, so no test here can fail");
});

beforeEach(async () => {
	writes = [];
	// The real `ProcessTerminal` writes to the developer's own terminal otherwise, and the card here
	// is painted for real.
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	if (typeof process.stdin.setRawMode === "function") {
		vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
	}
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

	previousHeadless = setTerminalHeadless(false);
	isolated = enterIsolatedConfigRoot("card-ground", { defaultProfile: true });
	resetLaunchFactsForTest();
	resetSettingsForTest();
	resetGroundTintsForTest();
	// `paintFirstFrame` and the recorder both read the store, and neither is allowed a default.
	await Settings.init({ inMemory: true, cwd: isolated.root });
});

afterEach(async () => {
	for (const close of opened.reverse()) await close();
	opened.length = 0;
	takeFirstFrame()?.ui.stop();
	vi.restoreAllMocks();
	resetGroundTintsForTest();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	setTerminalHeadless(previousHeadless);
	isolated?.restore();
});

/** The bytes written while `act` runs and the frame it schedules settles. */
async function bytesFrom(act: () => void): Promise<string> {
	writes.length = 0;
	act();
	// Renders are scheduled rather than written inline.
	await setTimeout(40);
	return writes.join("");
}

/** Record a ground the way the session does, then drop the memo so the next read hits the file. */
async function recordGround(hex: string): Promise<void> {
	await recordLaunchFacts({ terminalGround: hex });
	resetLaunchFactsForTest();
}

/** The card, painted for real, with the bytes it wrote. */
async function paintCard(): Promise<string> {
	return await bytesFrom(() => paintFirstFrame("9.9.9"));
}

/** What the terminal answers, through its own parser. */
async function report(hex: string): Promise<string> {
	return await bytesFrom(() => {
		process.stdin.emit("data", osc11(hex));
	});
}

describe("the card is painted on the ground the session settles on", () => {
	// The derived-color half. `never` keeps the terminal's own background on screen, so the ground
	// the tints are mixed out of is the reported one and nothing else can supply it. The paint
	// decision is the other half, and it has its own describe below.
	beforeEach(() => {
		settings.set("tui.paintGround", "never");
	});

	it("knows the ground before the first paint, from what this terminal last reported", async () => {
		await recordGround(REPORTED);
		expect(readLaunchFacts().terminalGround).toBe(REPORTED);

		const card = await paintCard();

		// The owner answers with the recorded ground, so every color derived from it -- the ones that
		// exist and the ones added later -- resolves to the settled value on the first frame.
		expect(getVisibleGround()).toBe(REPORTED);
		// And the frame proves it reached the wire: the hairline is painted in the derived tint.
		expect(card).toContain(TINT[REPORTED]);
	});

	it("writes nothing when the terminal confirms the recorded ground", async () => {
		await recordGround(REPORTED);
		await paintCard();

		// The whole defect in one assertion: an answer that agrees with the card restyles nothing.
		expect(await report(REPORTED)).toBe("");
		expect(getVisibleGround()).toBe(REPORTED);
	});

	it("restyles once when nothing was recorded, which is the first launch in a terminal", async () => {
		// The honest boundary, and the control that gives the assertion above its meaning: with no
		// record the card has no ground, so the answer is what supplies one and the restyle is real.
		const card = await paintCard();
		expect(getVisibleGround()).toBeUndefined();
		expect(card).not.toContain(TINT[REPORTED]);

		expect(await report(REPORTED)).toContain(TINT[REPORTED]);
		expect(getVisibleGround()).toBe(REPORTED);
	});

	it("takes the terminal's answer over a record that no longer describes it", async () => {
		await recordGround(STALE);
		expect(await paintCard()).toContain(TINT[STALE]);

		// A record is a guess and the terminal is the fact, so the correction lands on the card's own
		// frame rather than at mount.
		expect(await report(REPORTED)).toContain(TINT[REPORTED]);
		expect(getVisibleGround()).toBe(REPORTED);
	});

	it("records the answer, so the next launch is the confirming case and not the first one", async () => {
		await paintCard();
		const mode = await mountSession();
		await report(REPORTED);
		// The recorder hands back a promise the product discards; a launch fact is worth one frame.
		await setTimeout(60);
		await mode.stop();

		resetLaunchFactsForTest();
		// Read through the reader a launch uses, so the key it is filed under is part of what is
		// proven: a value written under a key the card resolves differently is a value it never sees.
		expect(readLaunchFacts().terminalGround).toBe(REPORTED);
	});

	it("keeps the seeded ground when the session mounts over the card", async () => {
		await recordGround(REPORTED);
		await paintCard();

		const mode = await mountSession();
		await mode.stop();

		// Mounting used to overwrite the ground with whatever the terminal had reported by then,
		// which on a terminal that has not answered yet is nothing: the same restyle on a settled
		// screen, in the other direction.
		expect(getVisibleGround()).toBe(REPORTED);
	});
});

// The paint half. `auto` paints the theme ground only when the terminal's own is close enough that
// the emulator's padding margin cannot show a seam, so the decision NEEDS the ground -- and a card
// with no ground declines to paint and then paints once the answer lands, which is the whole
// background changing shade on a settled screen. `#0d1117` is inside titanium's tolerance of
// `#000000` and `#2b2b2b` is outside it, which is what makes these two arms different.
describe("the ground paint is decided on the card's own frame", () => {
	beforeEach(() => {
		settings.set("tui.paintGround", "auto");
	});

	it("paints the theme ground on the card, and the answer costs one re-assert and no repaint", async () => {
		await recordGround(REPORTED);

		const card = await paintCard();

		// Painted, so the ground on screen is the theme's and every tint follows it.
		expect(card).toContain(THEME_GROUND_PAINT);
		expect(getVisibleGround()).toBe(THEME_GROUND);

		// The answer describes the background BEFORE the card painted over it, which is
		// indistinguishable from something outside this process having clobbered the paint. So the
		// ground is re-asserted rather than assumed -- and that one sequence is the whole cost:
		// exactly the color already on screen, and not one row of the frame repainted.
		expect(await report(REPORTED)).toBe(THEME_GROUND_PAINT);
		expect(getVisibleGround()).toBe(THEME_GROUND);
	});

	it("leaves a terminal too far from the theme ground unpainted", async () => {
		await recordGround(STALE);

		expect(await paintCard()).not.toContain(THEME_GROUND_PAINT);
		expect(getVisibleGround()).toBe(STALE);
	});

	/**
	 * Invariant 5 for the paint half. The card decides the paint from the seeded ground; the mode
	 * re-decides it at mount, and a re-decision that reads the terminal directly reads `undefined`
	 * on a terminal that has not answered, which under `auto` is a decision NOT to paint. That
	 * un-paints the whole background half a second into a settled screen, the same defect as the
	 * hairline and across every row instead of one.
	 */
	it("keeps the painted ground when the session mounts over the card", async () => {
		await recordGround(REPORTED);
		expect(await paintCard()).toContain(THEME_GROUND_PAINT);

		writes.length = 0;
		const mode = await mountSession();
		const atMount = writes.join("");

		expect(getVisibleGround()).toBe(THEME_GROUND);
		expect(atMount).not.toContain(OSC11_RESET_BACKGROUND_SEQUENCE);
		await mode.stop();
	});
});

/** A session on its own storage, mounted over whatever is on screen, the way `main.ts` does. */
async function mountSession(): Promise<InteractiveMode> {
	const tempDir = TempDir.createSync("@pi-card-ground-");
	// `Settings.init` replaces the global store and `Settings.isolated()` builds a fresh one on the
	// defaults, so the suite's paint policy has to be carried into both or the mode runs on `auto`.
	const paintGround = settings.get("tui.paintGround");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	settings.set("tui.paintGround", paintGround);
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings: Settings.isolated({ "tui.paintGround": paintGround }),
		modelRegistry,
	});
	const mode = new InteractiveMode(session, "test");
	opened.push(async () => {
		await mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	// Neither decides what the ground is: one runs a subprocess and the other an animation timer.
	vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	await mode.init();
	await setTimeout(60);
	return mode;
}
