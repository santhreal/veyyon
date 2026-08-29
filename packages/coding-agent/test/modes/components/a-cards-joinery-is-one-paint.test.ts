// WHY THIS SUITE EXISTS (A-CARDS-RULES-DRAWN-IN-TWO-DIFFERENT-WEIGHTS).
//
// A card's frame derives from the ground the terminal reported (`cardOutlineColor()`), and eleven
// rules INSIDE cards did not: they took a static text token. The account manager's own comment called
// its pane separator "the hairline" while painting it `dim`; the model hub and the extension dashboard
// had the same line, the extension inspector drew its section rules in `dim`, the model browser drew
// its list separator in `muted`, and every scrolling overlay in the product restated
// `{ track: theme.fg("muted"), thumb: theme.fg("accent") }` — three of them with `dim` instead, so
// the same card's scroll track was one of two weights depending on which file drew it. On a grey
// terminal the frame moves with the ground and a static token does not, so one card's joinery read as
// two or three different lines.
//
// THE CLASS, NOT THE ELEVEN SITES. The rule is that a card draws its rules in exactly ONE paint, the
// one `cardOutlineColor()` returns. That is stronger than the sibling accent suite — a rule in `dim`
// is not the accent and is still wrong — and it is the invariant an operator sees: joinery is one
// line weight or it is not joinery. Anything a card wants louder than that is content and is not
// drawn in a box glyph.
//
// The variant space is the shared roster in `overlay-specs.ts`, whose roll-call literal lives in
// `a-card-first-frame-is-settled.test.ts`: a new card must be constructed there, and being there puts
// it into this sweep. Each card is rendered at three widths and at both colour depths, because a card
// that hides a split at one width shows it at another, and because a hand-written 24-bit escape is
// invisible to a 256-colour scan while the same bytes ARE the token at 24 bits. The extension
// inspector is a pane and not a card, so it is swept separately over `EXTENSION_KINDS`, one preview
// branch per kind.
//
// EXEMPTIONS, both narrow and both pinned by their own arm. The title row's ember tick, which is the
// product's progress-sun motif and is accent BY DESIGN, is removed before the walk, first occurrence
// only. The scrollbar THUMB keeps the accent: it is the position, the one thing on a scrollbar an
// operator reads, and it is drawn as a block (`█`), not a rule, so it never reaches this walk at all.
//
// WHAT IT DOES NOT CATCH. A rule painted as a BACKGROUND rather than a foreground (the sibling
// first-frame suite owns a card's fills). A rule in a state no `reachKeys` reach: the choke-point arm
// answers that for anything drawn through `cardOutlineColor()`, so only a NEW hand-rolled paint could
// hide there. `SettingsList`'s split-layout separator (`theme.hint("│ ")`, tui) is not reached by any
// spec here, because the settings card renders that list in `flat` layout; it is a real gap and it is
// the one place a second weight can still be introduced without going red.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AnsiPolicy } from "@veyyon/tui";
import { getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { Settings } from "../../../src/config/settings";
import { emberTick } from "../../../src/modes/components/composer-chrome";
import { InspectorPanel } from "../../../src/modes/components/extensions/inspector-panel";
import { EXTENSION_KINDS, type ExtensionKind, type ExtensionRow } from "../../../src/modes/components/extensions/types";
import { buildBrowserItems, ModelBrowser } from "../../../src/modes/components/model-browser";
import { cardOutlineColor, cardScrollbarTheme } from "../../../src/modes/theme/card-outline";
import { initTheme } from "../../../src/modes/theme/theme";
import { theme } from "../../../src/modes/theme/theme-binding";
import { openOf, rulePaints, withoutBrandTick } from "./card-chrome-kit";
import { DUMMY_REGISTRY, OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

let previousPolicy: AnsiPolicy;

beforeAll(async () => {
	// Colour is off under a test runner, because stdout is not a terminal, and every paint would then
	// be the empty string and every comparison below trivially true.
	previousPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme(false, "unicode", false, "titanium", "dark");
});

afterAll(async () => {
	setAnsiPolicy(previousPolicy);
	await initTheme(false);
});

afterEach(() => {
	motionClock.clear();
});

/** The one paint a card's rules may carry, at the current colour depth. */
function hairlineOpen(): string {
	return openOf(cardOutlineColor()("x"));
}

/** Every rule paint in a rendered card that is not the card's own hairline. */
function foreignPaints(lines: readonly string[]): string[] {
	const hairline = hairlineOpen();
	const foreign: string[] = [];
	for (const line of lines) {
		for (const paint of rulePaints(withoutBrandTick(line))) {
			if (paint.open === hairline) continue;
			foreign.push(`${JSON.stringify(paint.open)} on ${paint.glyph}`);
		}
	}
	return foreign;
}

/**
 * A payload each preview branch can read, one entry per kind. A `Record` over `ExtensionKind` rather
 * than a default arm, so adding a kind fails the type check here instead of quietly falling through
 * to a payload the new branch cannot parse.
 */
const INSPECTOR_PAYLOADS: Record<ExtensionKind, unknown> = {
	"extension-module": { note: "no payload this panel parses" },
	skill: { prompt: "The body of a skill, long enough to wrap at forty cells and then some." },
	rule: { note: "no payload this panel parses" },
	tool: { parameters: { path: { type: "string", default: "." }, deep: { type: "boolean" } } },
	mcp: { transport: "stdio", command: "server", args: ["--flag"], env: { TOKEN: "value" } },
	prompt: { note: "no payload this panel parses" },
	instruction: { note: "no payload this panel parses" },
	"context-file": { content: "# Heading\n\nA context line.\n- a list item\n" },
	hook: { note: "no payload this panel parses" },
	"slash-command": { note: "no payload this panel parses" },
};

/** One inspector row per kind, built here rather than discovered, so the sweep is the same everywhere. */
function inspectorRow(kind: ExtensionKind): ExtensionRow {
	return {
		id: `${kind}:fixture`,
		kind,
		name: `${kind}-fixture`,
		displayName: `${kind} fixture`,
		description: "A row built for this sweep, not discovered on disk.",
		trigger: "/fixture",
		path: "/repo/.veyyon/fixture.md",
		source: { provider: "fixture", providerName: "Fixture", level: "project" },
		state: "active",
		raw: INSPECTOR_PAYLOADS[kind],
	};
}

describe("a card's joinery is one paint", () => {
	/**
	 * The choke point: the scrollbar track is the same paint as the frame, so an overlay that scrolls
	 * cannot introduce a second weight by reaching for the shared theme. The thumb is deliberately a
	 * different paint — a track and a thumb that look alike is a scrollbar with no readable position.
	 */
	it("hands a card's scrollbar the frame's own paint for its track", () => {
		expect(cardScrollbarTheme().track("│")).toBe(cardOutlineColor()("│"));
		expect(cardScrollbarTheme().thumb("█")).not.toBe(cardOutlineColor()("█"));
	});

	/** A thumb is a block, so it is not a rule, so the sweep never has to exempt it. */
	it("draws the scrollbar thumb in a glyph this walk does not read", () => {
		expect(rulePaints(cardScrollbarTheme().thumb("█"))).toEqual([]);
		expect(rulePaints(cardScrollbarTheme().track("│"))).toEqual([{ open: hairlineOpen(), glyph: "│" }]);
	});

	/**
	 * The detector, in every direction the sweep depends on: a quiet-but-different token is a finding,
	 * an unpainted rule is a finding, the hairline is not, and an accented TITLE beside a hairline rule
	 * is not — same line, different span, which is what a substring search gets wrong.
	 */
	it("finds a foreign paint, and only a foreign paint", () => {
		expect(foreignPaints([`sidebar ${theme.fg("dim", "│")} pane`])).toEqual([
			`${JSON.stringify(openOf(theme.fg("dim", "x")))} on │`,
		]);
		expect(foreignPaints(["sidebar │ pane"])).toEqual(['"" on │']);
		expect(foreignPaints([cardOutlineColor()("├──┤")])).toEqual([]);
		expect(
			foreignPaints([`${cardOutlineColor()("┌─")}${theme.fg("accent", " Title ")}${cardOutlineColor()("─┐")}`]),
		).toEqual([]);
	});

	/**
	 * The tick is removed once per row, so a second accented rule on the title row is still a finding.
	 * Both depths, and load-bearing without truecolor: there the tick degrades to plain accent-painted
	 * rule, byte-identical to a rule someone paints beside it, so the row has to carry the tick FIRST
	 * for the plant to be distinguishable at all.
	 */
	it("exempts the title row's tick and nothing else on that row", () => {
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		try {
			for (const trueColor of [false, true]) {
				caps.trueColor = trueColor;
				const bare = `${cardOutlineColor()("┌")}${emberTick(trueColor, 2)} Title `;
				expect(foreignPaints([bare])).toEqual([]);
				const smuggled = `${cardOutlineColor()("┌")}${emberTick(trueColor, 2)}${theme.fg("accent", "──")} Title `;
				expect(foreignPaints([smuggled])).toEqual([
					`${JSON.stringify(openOf(theme.fg("accent", "x")))} on ─`,
					`${JSON.stringify(openOf(theme.fg("accent", "x")))} on ─`,
				]);
			}
		} finally {
			caps.trueColor = trueColorWas;
		}
	});

	it.each([false, true])("sweeps every overlay at three widths with trueColor=%s", async trueColor => {
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		caps.trueColor = trueColor;
		const unconstructable: string[] = [];
		const findings: string[] = [];
		try {
			for (const spec of OVERLAY_SPECS) {
				let card: RenderableOverlay;
				try {
					card = await spec.create();
				} catch (err) {
					unconstructable.push(`${spec.name}: ${err}`);
					continue;
				}
				try {
					if (spec.reachKeys && "handleInput" in card && typeof card.handleInput === "function") {
						for (const keys of spec.reachKeys) card.handleInput(keys);
					}
					for (const width of [80, 100, 140]) {
						for (const foreign of foreignPaints(card.render(width))) {
							findings.push(`${spec.name} at ${width}: ${foreign}`);
						}
					}
				} finally {
					if ("dispose" in card && typeof card.dispose === "function") card.dispose();
				}
			}
		} finally {
			caps.trueColor = trueColorWas;
		}

		expect(findings).toEqual([]);
		expect(unconstructable).toEqual([]);
	});

	/**
	 * The extension inspector is a PANE inside the dashboard's card, not a card of its own, so it is
	 * not in the roster above — and the roster's dashboard fixture shows whatever the checkout happens
	 * to discover, which reached none of the inspector's five section rules. Every preview branch draws
	 * its own rule, so the variant space is the kind list, read at run time from `EXTENSION_KINDS`: a
	 * new kind is a new preview branch and lands in this sweep without anyone remembering to add it.
	 */
	it.each([false, true])("draws every inspector preview's section rule in one paint, trueColor=%s", trueColor => {
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		const panel = new InspectorPanel();
		const findings: string[] = [];
		try {
			caps.trueColor = trueColor;
			for (const kind of EXTENSION_KINDS) {
				panel.setExtension(inspectorRow(kind));
				for (const width of [40, 80, 140]) {
					for (const foreign of foreignPaints(panel.render(width))) {
						findings.push(`${kind} at ${width}: ${foreign}`);
					}
				}
			}
		} finally {
			caps.trueColor = trueColorWas;
		}

		expect(findings).toEqual([]);
	});

	/** The sweep above is only evidence if each kind reaches a rule at all, rather than passing empty. */
	it("gives every extension kind a preview with a section rule in it", () => {
		const panel = new InspectorPanel();
		const ruleless: string[] = [];
		for (const kind of EXTENSION_KINDS) {
			panel.setExtension(inspectorRow(kind));
			const rules = panel.render(80).flatMap(line => rulePaints(withoutBrandTick(line)));
			if (rules.length === 0) ruleless.push(kind);
		}

		expect(ruleless).toEqual([]);
	});

	/**
	 * The model browser is the picker card's list pane, and its separator row — the rule between the
	 * models used recently and the rest — renders only when both sides of it exist. The recents list
	 * comes from profile storage, which a fixture cannot seed through the picker, so the pane is
	 * driven here directly: two models over two providers, one of them in the recents order.
	 */
	it.each([false, true])("draws the model browser's recents separator in one paint, trueColor=%s", async trueColor => {
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		caps.trueColor = trueColor;
		const browser = new ModelBrowser(await Settings.init(), {});
		browser.setMaxVisible(20);
		browser.setMruOrder(["alpha/alpha-1"]);
		browser.setItems(buildBrowserItems(DUMMY_REGISTRY.getAll()));
		const findings: string[] = [];
		const unseparated: number[] = [];
		try {
			for (const width of [80, 100, 140]) {
				const lines = browser.render(width);
				// Green by absence is the failure mode here: assert the row is on screen before
				// asserting its paint. A separator row is a horizontal run and nothing else, and it is
				// a few cells narrower than the pane, so it is counted rather than matched exactly.
				if (!lines.some(line => (line.match(/─/g) ?? []).length >= width - 10)) unseparated.push(width);
				for (const foreign of foreignPaints(lines)) findings.push(`at ${width}: ${foreign}`);
			}
		} finally {
			browser.disposeHoverMotion();
			caps.trueColor = trueColorWas;
		}

		expect(unseparated).toEqual([]);
		expect(findings).toEqual([]);
	});
});
