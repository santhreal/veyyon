import { describe, expect, it } from "bun:test";
import {
	optionalNumber,
	optionalPositiveNumber,
	UNSET_NUMBER,
	UNSET_NUMBER_OPTION_LABEL,
	UNSET_NUMBER_OPTION_VALUE,
	unsetNumberOption,
} from "@veyyon/coding-agent/config/optional-number";

/**
 * What "unset" means for a numeric setting, in exactly one place.
 *
 * Thirteen numeric settings encoded unset as `-1`, each declaring its own `Default`
 * submenu row (some valued `"-1"`, some `"default"`) and each read site re-deriving
 * unset with its own comparison. Two things went wrong, and both are pinned here:
 * the UI showed `Default` for one setting and a literal `-1` for the next, and the
 * `>= 0` read test discarded legitimate negative values, which made a negative
 * presence/repetition penalty silently unreachable (operator review 2026-07-24).
 */

describe("reading an optional numeric setting", () => {
	/** Unset is the ABSENCE of a value, so -1 is a value like any other. It used
	 * to be the sentinel, which made a -1 presence penalty — a penalty the
	 * providers accept — impossible to configure. A config that still holds the
	 * old sentinel is handled once, by the load migration in `config/settings.ts`,
	 * not by this read. */
	it("keeps the value that used to be the sentinel", () => {
		expect(optionalNumber(UNSET_NUMBER)).toBe(-1);
		expect(optionalNumber(-1)).toBe(-1);
	});

	it("treats an absent value as unset", () => {
		expect(optionalNumber(undefined)).toBeUndefined();
		expect(optionalNumber(null)).toBeUndefined();
	});

	it("keeps a negative value that is not the sentinel", () => {
		// The bug this replaces: `presencePenalty: -0.5` is valid at OpenAI and was
		// dropped by a `>= 0` test, so the setting did nothing.
		expect(optionalNumber(-0.5)).toBe(-0.5);
		expect(optionalNumber(-2)).toBe(-2);
		expect(optionalNumber(-1.5)).toBe(-1.5);
	});

	it("keeps zero, which is a real value for temperature and the penalties", () => {
		// `0` means deterministic sampling / no penalty; conflating it with unset
		// makes the most deliberate setting in the group unreachable.
		expect(optionalNumber(0)).toBe(0);
	});

	it("keeps ordinary positive values unchanged", () => {
		expect(optionalNumber(0.7)).toBe(0.7);
		expect(optionalNumber(40)).toBe(40);
	});

	it("treats a non-finite value as unset rather than forwarding NaN to a provider", () => {
		expect(optionalNumber(Number.NaN)).toBeUndefined();
		expect(optionalNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
});

describe("reading an optional amount that must be positive", () => {
	it("rejects zero and negatives alike", () => {
		// A token count, timeout, or window size has no meaning at or below zero, so
		// this is a separate question from "is it set" and gets a separate answer.
		expect(optionalPositiveNumber(UNSET_NUMBER)).toBeUndefined();
		expect(optionalPositiveNumber(0)).toBeUndefined();
		expect(optionalPositiveNumber(-5)).toBeUndefined();
	});

	it("keeps a usable amount", () => {
		expect(optionalPositiveNumber(170_000)).toBe(170_000);
	});
});

describe("the shared unset submenu row", () => {
	it("uses the option value the selector translates, never the raw number", () => {
		// A row valued `"-1"` forward-parses fine but never highlights as the current
		// value, because the reverse mapping renders a stored -1 as `"default"`.
		expect(unsetNumberOption().value).toBe(UNSET_NUMBER_OPTION_VALUE);
		expect(UNSET_NUMBER_OPTION_VALUE).toBe("default");
		expect(unsetNumberOption().value).not.toBe(String(UNSET_NUMBER));
	});

	it("labels itself consistently across every setting that uses it", () => {
		expect(unsetNumberOption().label).toBe(UNSET_NUMBER_OPTION_LABEL);
		expect(UNSET_NUMBER_OPTION_LABEL).toBe("Default");
	});

	it("carries a per-setting description, defaulting to the provider wording", () => {
		expect(unsetNumberOption().description).toBe("Use the provider default");
		expect(unsetNumberOption("Use the compaction model's own context window").description).toBe(
			"Use the compaction model's own context window",
		);
	});
});
