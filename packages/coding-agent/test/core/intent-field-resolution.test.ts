import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveIntentField } from "@veyyon/coding-agent/system-prompt-builder/gate-inputs";
import { INTENT_FIELD } from "@veyyon/wire";

/**
 * Contracts: the ONE place that decides whether intent tracing is on.
 *
 * WHY THIS HAS A SUITE OF ITS OWN. `resolveIntentField` answers a question with TWO readers, and they
 * must never disagree. It decides whether the system prompt carries the bullet explaining the intent
 * field, and it decides whether every tool schema sent to the model actually carries that field. A
 * prompt that explains a field the schemas do not have is worse than one that says nothing, so the
 * answer has exactly one owner: `resolveGateInputs` calls it for the prompt and `sdk.ts` calls it for
 * the agent.
 *
 * THE EXPRESSION WAS ABOUT TO EXIST TWICE. When `tools.intentTracing` was made a live gate, `sdk.ts`
 * needed the same lookup that `gate-inputs.ts` already had, and the obvious edit was to write it out
 * again. Two copies of `$flag("VEYYON_INTENT_TRACING", settings.get("tools.intentTracing"))` is the
 * shape that drifts: one loses the env flag, or gains a `?? false`, and nothing fails. Both readers go
 * through this function instead.
 *
 * WHY THE ENV FLAG IS THE PART UNDER TEST. A mutation run said so. Replacing the whole call with a bare
 * `settings.get("tools.intentTracing")` broke NOTHING across the gate suites: every one of them sets the
 * setting, none of them sets the variable, so the override that exists for operators to force the
 * feature on or off was completely uncovered. These cases are that coverage.
 */

const ENV_VAR = "VEYYON_INTENT_TRACING";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	delete process.env[ENV_VAR];
	delete Bun.env[ENV_VAR];
});

/** Set the env override the way an operator does, on both views of the environment. */
function setFlag(value: string): void {
	process.env[ENV_VAR] = value;
	Bun.env[ENV_VAR] = value;
}

describe("without the env override, the setting decides", () => {
	/**
	 * `tools.intentTracing` ships as `true`, so the shipped answer is the field's name. Asserted as the
	 * exact `INTENT_FIELD` constant rather than "some string", because the name is what the prompt
	 * interpolates and what the schemas add: a different name is a silent mismatch between them.
	 */
	it("returns the intent field's name when the setting is on", () => {
		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": true }))).toBe(INTENT_FIELD);
	});

	/** And `undefined` when off, which is what the prompt and the agent both read as "no field". */
	it("returns undefined when the setting is off", () => {
		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": false }))).toBeUndefined();
	});

	/** The shipped default is on, so a configuration that says nothing gets the field. */
	it("follows the shipped default when nothing is configured", () => {
		expect(resolveIntentField(Settings.isolated())).toBe(INTENT_FIELD);
	});
});

describe("the env override wins over the setting", () => {
	/**
	 * THE HALF THAT HAD NO COVERAGE. This is the escape hatch an operator uses to force the feature on
	 * for a run without editing their configuration, and it is the reason the lookup is not a bare
	 * `settings.get`. Both directions are checked, because an override that can only turn something on
	 * is not an override.
	 */
	it("forces the field on over a setting that says off", () => {
		setFlag("1");

		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": false }))).toBe(INTENT_FIELD);
	});

	it("forces the field off over a setting that says on", () => {
		setFlag("0");

		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": true }))).toBeUndefined();
	});

	/**
	 * `$flag` accepts several spellings of true, and an operator will type whichever one they know. Each
	 * is checked rather than assumed, because a lookup that only understood `"1"` would satisfy the case
	 * above and quietly ignore `VEYYON_INTENT_TRACING=true`.
	 */
	it.each(["1", "true", "TRUE", "yes", "YES", "on", "ON", "y", "Y"])("reads %s as on", value => {
		setFlag(value);

		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": false }))).toBe(INTENT_FIELD);
	});

	/**
	 * Anything that is not a recognised spelling of true is off, which is `$flag`'s rule. `"false"`,
	 * `"no"` and a typo all land here, so an operator who sets the variable wrong gets the feature off
	 * rather than a value that depends on which typo they made.
	 */
	it.each(["0", "false", "FALSE", "no", "off", "nope", "2"])("reads %s as off", value => {
		setFlag(value);

		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": true }))).toBeUndefined();
	});

	/**
	 * An EMPTY variable is not an override. Setting a variable to the empty string is what a shell does
	 * when a value is unset (`VEYYON_INTENT_TRACING=$SOMETHING_UNDEFINED`), and treating that as "off"
	 * would silently disable the feature for anyone whose wrapper script has an empty variable.
	 */
	it("ignores an empty variable and falls back to the setting", () => {
		setFlag("");

		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": true }))).toBe(INTENT_FIELD);
		expect(resolveIntentField(Settings.isolated({ "tools.intentTracing": false }))).toBeUndefined();
	});
});

describe("it is a function, so both readers get the current answer", () => {
	/**
	 * Called twice across a change, it answers twice. This is what makes `tools.intentTracing` a LIVE
	 * gate: `sdk.ts` holds a closure over this call rather than its result, and the agent invokes that
	 * closure per turn. A memoized resolver would make the gate frozen again with nothing to say so.
	 */
	it("reflects a setting change on the next call", () => {
		const on = Settings.isolated({ "tools.intentTracing": true });
		const off = Settings.isolated({ "tools.intentTracing": false });

		expect(resolveIntentField(on)).toBe(INTENT_FIELD);
		expect(resolveIntentField(off)).toBeUndefined();
		expect(resolveIntentField(on)).toBe(INTENT_FIELD);
	});

	/** And an env change between two calls, which a captured constant could not see either. */
	it("reflects an env change on the next call", () => {
		const settings = Settings.isolated({ "tools.intentTracing": true });

		expect(resolveIntentField(settings)).toBe(INTENT_FIELD);
		setFlag("0");
		expect(resolveIntentField(settings)).toBeUndefined();
		delete process.env[ENV_VAR];
		delete Bun.env[ENV_VAR];
		expect(resolveIntentField(settings)).toBe(INTENT_FIELD);
	});
});
