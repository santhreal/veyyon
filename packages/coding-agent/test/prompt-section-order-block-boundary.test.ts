/**
 * A `promptSectionOrder` that cannot be honoured must say so.
 *
 * WHY THIS SUITE EXISTS. `buildSystemPrompt` returns the prompt as parts.
 * `parts[0]` is the rendered template — the byte-stable prefix a provider caches —
 * and each later part is one runtime section whose text changes during a session.
 * A runtime section therefore stays after `parts[0]` no matter what order is
 * requested, because moving one into the prefix would invalidate the cache on
 * every dictionary load. That refusal is correct and deliberate.
 *
 * Being quiet about it was not. `applyPromptSectionOrderToParts` warned only when
 * a name matched no section at all, so `["shorthand", "role", ...]` — both names
 * perfectly well known — produced a prompt in a different order from the one
 * asked for, with nothing logged and no way to tell from the output. The cost
 * lands on evals: an arm testing whether teaching the shorthand notation FIRST
 * changes behaviour would have run the control and recorded it as the treatment,
 * and the comparison would have looked like "the lever does nothing".
 *
 * Law 10: a refusal that is loud and recorded is fine, a quiet one is a defect.
 */
import { describe, expect, it, vi } from "bun:test";
import { renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { applyPromptSectionOrderToParts } from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";
import { logger } from "@veyyon/utils";

/** A template block carrying two real banner sections, as `parts[0]` always does. */
const TEMPLATE = [
	"preamble text",
	`${renderBanner("ROLE")}\n\nrole body`,
	`${renderBanner("RUNTIME")}\n\nruntime body`,
].join("\n");

/** One runtime part, exactly as the assembler emits it: its banner, then its text. */
const SHORTHAND = `${renderBanner("SHORTHAND")}\n\nshorthand body`;

interface Warning {
	message: string;
	fields?: Record<string, unknown>;
}

function captureWarnings(run: () => void): Warning[] {
	const warnings: Warning[] = [];
	const spy = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields });
	});
	try {
		run();
	} finally {
		spy.mockRestore();
	}
	return warnings;
}

describe("an order that crosses the caching boundary is reported", () => {
	/**
	 * `shorthand` is requested before `role`, but it cannot move ahead of the
	 * static cached-prefix block. The caller must be told which section stayed.
	 */
	it("warns when a runtime section is asked to precede a static section", () => {
		const warnings = captureWarnings(() =>
			applyPromptSectionOrderToParts([TEMPLATE, SHORTHAND], ["shorthand", "role", "runtime"]),
		);

		const crossing = warnings.find(warning => warning.message.includes("precede a static section"));
		expect(crossing, `no warning was emitted; got ${JSON.stringify(warnings)}`).toBeDefined();
		// It must NAME the section, or the operator cannot tell which part of their
		// order was dropped.
		expect(crossing?.fields?.sections).toEqual(["shorthand"]);
		// And give the reason, because the refusal is intentional and a reader who
		// does not know about the cached prefix would file it as a bug.
		expect(String(crossing?.fields?.reason)).toContain("cached prefix");
	});

	/**
	 * The refusal is real, not merely announced. A warning that fired while the
	 * section actually moved would be worse than silence.
	 */
	it("keeps the template block first regardless", () => {
		const ordered = applyPromptSectionOrderToParts([TEMPLATE, SHORTHAND], ["shorthand", "role", "runtime"]);

		expect(ordered[0]?.startsWith("preamble text")).toBe(true);
		expect(ordered[1]).toBe(SHORTHAND);
	});
});

describe("an order that can be honoured stays quiet", () => {
	/**
	 * The half that keeps the warning worth reading. A warning that fired on every
	 * ordinary reorder would be tuned out, and then the real one is invisible too.
	 */
	it("says nothing when the runtime section comes after every template section", () => {
		const warnings = captureWarnings(() =>
			applyPromptSectionOrderToParts([TEMPLATE, SHORTHAND], ["role", "runtime", "shorthand"]),
		);

		expect(warnings).toEqual([]);
	});

	/** Reordering only template sections never touches the boundary. */
	it("says nothing when only template sections are named", () => {
		const warnings = captureWarnings(() =>
			applyPromptSectionOrderToParts([TEMPLATE, SHORTHAND], ["runtime", "role"]),
		);

		expect(warnings).toEqual([]);
	});

	/**
	 * A runtime section named with no template section after it is honoured as
	 * written: there is nothing for it to jump ahead of.
	 */
	it("says nothing when a runtime section is named alone", () => {
		const warnings = captureWarnings(() => applyPromptSectionOrderToParts([TEMPLATE, SHORTHAND], ["shorthand"]));

		expect(warnings).toEqual([]);
	});
});

describe("the unknown-name warning still works", () => {
	/**
	 * The pre-existing guard, kept under test because the new check sits directly
	 * above it and shares its inputs. Both must be able to fire.
	 */
	it("warns about a name that matches no section at all", () => {
		const warnings = captureWarnings(() =>
			applyPromptSectionOrderToParts([TEMPLATE, SHORTHAND], ["no-such-section", "role"]),
		);

		const unknown = warnings.find(warning => warning.message.includes("missing from the assembled system prompt"));
		expect(unknown, `no warning was emitted; got ${JSON.stringify(warnings)}`).toBeDefined();
		expect(unknown?.fields?.section).toBe("no-such-section");
	});
});
