import { describe, expect, test } from "bun:test";
import { openaiWebsocketPreference } from "@veyyon/coding-agent/config/openai-websockets-mode";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";

// The session's agent and the `/session` provider section read the transport hint through this one
// mapping. Every value the setting declares maps here, so a new enum value fails the sweep until it
// has a recorded reading.
describe("openaiWebsocketPreference", () => {
	const expected: Record<string, boolean | undefined> = { auto: undefined, off: false, on: true };

	test("maps every declared value of providers.openaiWebsockets", () => {
		const declared = SETTINGS_SCHEMA["providers.openaiWebsockets"].values;
		expect(Object.keys(expected).sort()).toEqual([...declared].sort());
		for (const value of declared) {
			expect(openaiWebsocketPreference(value)).toBe(expected[value]);
		}
	});

	test("an unset value leaves the choice to the provider", () => {
		expect(openaiWebsocketPreference(undefined)).toBeUndefined();
	});
});
