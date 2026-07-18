/**
 * Palette rows are action-first: a command's live autocomplete description
 * must lead with what the command DOES ("Toggle plan mode · off"), never with
 * a bare state label ("Plan: off") that tells a new user nothing. This locks
 * the pattern at the source level so state-only descriptions can't creep back.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";

// A state-label return looks like `"Plan: off"` / `Loop: on (…)` — one or two
// capitalized words followed by ": " inside a string/template literal.
const STATE_LABEL = /["'`]\s*[A-Z][a-z]+(?: [a-z]+)?: /;

describe("builtin palette descriptions", () => {
	it("no getTuiAutocompleteDescription returns a bare state label", () => {
		for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
			const hook = command.getTuiAutocompleteDescription;
			if (!hook) continue;
			expect(STATE_LABEL.test(hook.toString()), `/${command.name} palette description is state-only`).toBe(false);
		}
	});
});
