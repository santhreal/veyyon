/**
 * The banner grammar has to give ONE answer, and every consumer has to ask it.
 *
 * WHY THIS SUITE EXISTS. A banner is a name line followed by a rule of `=`. Both
 * halves are load-bearing: without the underline requirement, any line of prose
 * that happens to read `SHORTHAND` opens a section. The rule was stated in one
 * place for cutting a document and in another for identifying one, and the second
 * statement left the underline out — `applyPromptSectionOrderToParts` identified a
 * part by `part.split("\n", 1)[0].trim()` alone. So the reorderer could claim a
 * section the splitter does not see, rank a part by a banner that is not there, and
 * report a name as known when nothing in the prompt carries it.
 *
 * Nothing was observed to break, because an assembled runtime part always carries
 * its underline. That is exactly what a latent divergence looks like from outside,
 * and it is why these tests assert the two answers AGREE rather than asserting each
 * separately: two suites that each pin one spelling would both stay green while the
 * spellings drifted apart.
 */
import { describe, expect, it, vi } from "bun:test";
import { logger } from "@veyyon/utils";
import {
	bannerTable,
	describeBanner,
	hasBanner,
	isBannerUnderline,
	leadingBannerName,
	renderBanner,
	startsWithBanner,
} from "./banner-grammar";
import { applyPromptSectionOrderToParts, splitPromptSections } from "./prompt-sections";
import { BANNERED_SECTIONS } from "./section-registry";

describe("what counts as a banner", () => {
	/** The shipped form, as `renderBanner` writes it. Nothing else has to match it. */
	it("recognises the banner it renders", () => {
		expect(leadingBannerName(`${renderBanner("ROLE")}\n\nbody`)).toBe("ROLE");
	});

	/**
	 * The case the reorderer used to get wrong. A first line that reads like a banner
	 * name is not a banner without its underline, and treating it as one invents a
	 * section boundary the splitter will not cut on.
	 */
	it("refuses a name line with no underline under it", () => {
		expect(leadingBannerName("ROLE\nordinary prose\nmore prose")).toBeUndefined();
	});

	/**
	 * The recognition width is four, deliberately below the fourteen that ships, so a
	 * hand-written `PROMPT_SECTIONS/role.md` underlined by eye still parses. Three is
	 * below it and must be refused, or the validator accepts a file the splitter then
	 * silently leaves as ordinary text.
	 */
	it("takes four `=` and refuses three", () => {
		expect(leadingBannerName("ROLE\n====\nbody")).toBe("ROLE");
		expect(leadingBannerName("ROLE\n===\nbody")).toBeUndefined();
		expect(isBannerUnderline("====")).toBe(true);
		expect(isBannerUnderline("===")).toBe(false);
		expect(isBannerUnderline(undefined)).toBe(false);
	});

	/**
	 * The prose a refused file is shown has to state the width the code enforces.
	 *
	 * Derived from BEHAVIOUR rather than compared to a constant: the shortest
	 * underline `startsWithBanner` actually accepts is discovered by probing, and the
	 * number the message quotes must be that one. An English restatement of the rule
	 * cannot drift from the rule under this test, which is the whole reason the
	 * message is not written by hand at the throw site.
	 */
	it("quotes the width it actually enforces", () => {
		let shortestAccepted = 0;
		for (let width = 1; width <= 40; width++) {
			if (startsWithBanner(`ROLE\n${"=".repeat(width)}\nbody`, "ROLE")) {
				shortestAccepted = width;
				break;
			}
		}

		expect(shortestAccepted).toBeGreaterThan(0);
		expect(describeBanner("ROLE")).toBe(`"ROLE" followed by a line of at least ${shortestAccepted} "=" characters`);
	});

	/** A document with no second line at all cannot open a section. */
	it("refuses a single-line document", () => {
		expect(leadingBannerName("ROLE")).toBeUndefined();
		expect(leadingBannerName("")).toBeUndefined();
	});

	/**
	 * `startsWithBanner` is the predicate VIEW of the same function, not a second
	 * implementation. If it ever stops agreeing, the override validator and the
	 * splitter are back to accepting different files.
	 */
	it("answers the predicate view identically", () => {
		const cases = [`${renderBanner("ROLE")}\nbody`, "ROLE\nprose", "ROLE\n===\nbody", "ROLE", ""];
		for (const text of cases) {
			expect(startsWithBanner(text, "ROLE"), `disagreed on ${JSON.stringify(text)}`).toBe(
				leadingBannerName(text) === "ROLE",
			);
		}
		// And it is a name comparison, not a prefix test: a longer banner name whose
		// first word matches must not satisfy the shorter one.
		expect(startsWithBanner(`${renderBanner("SHORTHAND HANDLES")}\nbody`, "SHORTHAND")).toBe(false);
	});
});

describe("the splitter and the identifier agree", () => {
	/**
	 * The invariant the divergence broke. Whatever `leadingBannerName` claims a
	 * document opens with, the splitter must cut there — and when it claims nothing,
	 * the splitter must leave the text in the preamble.
	 */
	it("cuts exactly where the identifier says a section begins", () => {
		const withBanner = `${renderBanner("SHORTHAND")}\n\nbody text`;
		expect(leadingBannerName(withBanner)).toBe("SHORTHAND");
		expect(splitPromptSections(withBanner).map(region => region.name)).toEqual(["preamble", "shorthand"]);

		const withoutUnderline = "SHORTHAND\n\nbody text";
		expect(leadingBannerName(withoutUnderline)).toBeUndefined();
		expect(splitPromptSections(withoutUnderline).map(region => region.name)).toEqual(["preamble"]);
	});
});

describe("the reorderer identifies a runtime part by the same grammar", () => {
	const TEMPLATE = [
		"preamble text",
		`${renderBanner("ROLE")}\n\nrole body`,
		`${renderBanner("RUNTIME")}\n\nruntime body`,
	].join("\n");

	/**
	 * The bug, made observable. A part opening with the bare word `SHORTHAND` and no
	 * underline is not the shorthand section. Ranking it as one puts it ahead of the
	 * real bannered part, so a harness asking for `shorthand` first gets a prompt
	 * ordered by a section that is not in it.
	 */
	it("does not rank an unbannered part as the section its first line names", () => {
		const notASection = "SHORTHAND\n\nthis part carries no banner";
		const real = `${renderBanner("SHORTHAND HANDLES")}\n\nhandle table`;

		const ordered = applyPromptSectionOrderToParts([TEMPLATE, notASection, real], ["shorthand", "shorthand-handles"]);

		// The real bannered section is ranked; the impostor keeps its position at the
		// end, having matched nothing.
		expect(ordered[1]).toBe(real);
		expect(ordered[2]).toBe(notASection);
	});

	/**
	 * And the name is reported UNKNOWN rather than silently satisfied. An operator
	 * naming a section that no part carries has to be told, which is the whole
	 * purpose of the existing warning; identifying the impostor suppressed it.
	 */
	it("reports a name that only an unbannered part appears to carry", () => {
		const warnings: string[] = [];
		const spy = vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			applyPromptSectionOrderToParts([TEMPLATE, "SHORTHAND\n\nno banner here"], ["shorthand"]);
		} finally {
			spy.mockRestore();
		}

		expect(warnings.some(message => message.includes("missing from the assembled system prompt"))).toBe(true);
	});
});

describe("one table builder serves every registry", () => {
	/**
	 * The system prompt's table used to be built by its own `Object.fromEntries`
	 * beside the shared one, with the banner filter written out inline instead of
	 * asking `hasBanner`. Two spellings of one table is how a banner ends up
	 * recognised by one caller and missed by another, so this pins that the shared
	 * builder reproduces the registry exactly.
	 */
	it("maps every bannered section's name to its id and nothing else", () => {
		const table = bannerTable(BANNERED_SECTIONS);

		expect(BANNERED_SECTIONS.length).toBeGreaterThan(0);
		for (const section of BANNERED_SECTIONS) {
			expect(table[section.name], `${section.name} is missing from the table`).toBe(section.id);
		}
		expect(Object.keys(table).length).toBe(BANNERED_SECTIONS.length);
	});

	/** A row with no banner contributes no entry, rather than a `null` key. */
	it("drops a section that has no banner", () => {
		const table = bannerTable([
			{ id: "conventions", name: null },
			{ id: "role", name: "ROLE" },
		]);

		expect(table).toEqual({ ROLE: "role" });
		expect(hasBanner({ id: "conventions", name: null })).toBe(false);
		expect(hasBanner({ id: "role", name: "ROLE" })).toBe(true);
	});
});
