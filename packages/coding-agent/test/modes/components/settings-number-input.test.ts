/**
 * What a number typed into `/settings` is allowed to become.
 *
 * WHY THIS EXISTS. Fifteen number settings carried a full `ui` block and rendered no row
 * at all, because `pathToSettingDef` returned `null` for a number with no `ui.options`.
 * The fix renders them as the same text input `string`, `record` and `array` already use,
 * and a text input hands back a STRING. The write path it hands to did
 * `settings.set(path, Number(value))`, so `"abc"` stored NaN, `""` stored 0, `"0x10"`
 * stored 16 and `"1e400"` stored Infinity, none of them reported.
 *
 * That would have been a worse bug than the one being fixed. An unreachable row is at
 * least honest about being absent; a retry delay that silently became 0, or a cache TTL
 * that became NaN, is a setting the operator believes they configured. So every rejection
 * below is asserted on the exact input AND the exact message, because the message is the
 * whole user-visible behaviour: `TextInputSubmenu` catches the throw, renders it in red
 * under the input, and keeps the submenu open.
 */
import { describe, expect, it } from "bun:test";
import { getUi } from "@veyyon/coding-agent/config/settings-schema";
import { parseNumberSetting, UNSET_NUMBER_INPUT } from "@veyyon/coding-agent/modes/components/settings-selector";

/** Declares `min: 0`: a wait cannot be negative. */
const DELAY = "retry.maxDelayMs";
/** Declares `min: 1`: one identical call is the smallest run that can repeat. */
const THRESHOLD = "model.toolCallLoopGuard.threshold";

describe("a number typed into a settings text box", () => {
	it("stores a plain decimal", () => {
		expect(parseNumberSetting(DELAY, "250")).toBe(250);
		expect(parseNumberSetting(DELAY, "0")).toBe(0);
		expect(parseNumberSetting(DELAY, "1.5")).toBe(1.5);
	});

	/**
	 * The footer under the input says "Clear field to unset", and for a number that has
	 * to remove the key so the schema default applies. `Number("")` is 0, and storing a
	 * zero here is the exact silent coercion this whole file exists to refuse.
	 */
	it("clears the setting for an empty box instead of storing zero", () => {
		expect(parseNumberSetting(DELAY, "")).toBe(UNSET_NUMBER_INPUT);
		expect(parseNumberSetting(DELAY, "   ")).toBe(UNSET_NUMBER_INPUT);
	});

	it.each([
		["abc", '"abc" is not a number. Type digits only, for example 250.'],
		["12abc", '"12abc" is not a number. Type digits only, for example 250.'],
		// `Number("0x10")` is 16. Nobody typing a retry delay means sixteen.
		["0x10", '"0x10" is not a number. Type digits only, for example 250.'],
		// `Number("1e400")` is Infinity, which serialises to null in the config file.
		["1e400", '"1e400" is not a number. Type digits only, for example 250.'],
		// `Number("1e2")` is 100, but exponent notation in a millisecond field is far more
		// likely a typo than an intent, and the digits-only rule is the one legible rule.
		["1e2", '"1e2" is not a number. Type digits only, for example 250.'],
		// `Number(" 5")` is 5. A control that silently repairs input is a control that
		// silently accepts the next thing it should have refused.
		[" 5", '" 5" is not a number. Type digits only, for example 250.'],
		["5 ", '"5 " is not a number. Type digits only, for example 250.'],
		["1,000", '"1,000" is not a number. Type digits only, for example 250.'],
		["Infinity", '"Infinity" is not a number. Type digits only, for example 250.'],
		["NaN", '"NaN" is not a number. Type digits only, for example 250.'],
	])("refuses %p with a visible message", (input, message) => {
		expect(() => parseNumberSetting(DELAY, input)).toThrow(message);
	});

	/** The bound is the schema's, not the input's. `-5` is refused because `min: 0` says so. */
	it("refuses a value below the minimum the schema declares", () => {
		expect(getUi(DELAY)?.min).toBe(0);
		expect(() => parseNumberSetting(DELAY, "-5")).toThrow("Must be at least 0.");

		expect(getUi(THRESHOLD)?.min).toBe(1);
		expect(() => parseNumberSetting(THRESHOLD, "0")).toThrow("Must be at least 1.");
		expect(parseNumberSetting(THRESHOLD, "1")).toBe(1);
	});

	/**
	 * A setting with no declared bound accepts any decimal. Enforcing a range nobody wrote
	 * down would refuse values that were legal before the row was reachable at all, and
	 * `providers.ollama-cloud.maxConcurrency` is the case that makes this concrete: its
	 * description documents 0 as "no provider-specific limit", so a guessed `min: 1` at
	 * the input would have refused a documented value.
	 */
	it("accepts any decimal where the schema declares no bound", () => {
		const unbounded = "subagent.idleTtlMs";
		expect(getUi(unbounded)?.min).toBeUndefined();
		expect(getUi(unbounded)?.max).toBeUndefined();
		expect(parseNumberSetting(unbounded, "99999")).toBe(99999);
		expect(getUi("providers.ollama-cloud.maxConcurrency")?.min).toBe(0);
		expect(parseNumberSetting("providers.ollama-cloud.maxConcurrency", "0")).toBe(0);
	});
});
