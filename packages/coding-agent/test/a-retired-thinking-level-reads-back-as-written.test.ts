/**
 * WHY: `defaultThinkingLevel` is retired, and an existing settings file is still honoured by reading it
 * as the `defaultEffort` `*` row. The settings store reads a value its enum does not declare as the
 * declared default, and the declaration listed the efforts and `auto` but not `off`. A profile that
 * had turned thinking off therefore started every session on `high`.
 *
 * Class closed: every level of the configured thinking vocabulary, read from the retired setting,
 * reaches the effort resolver as written. The sweep reads `CONFIGURED_THINKING_LEVELS` at run time,
 * so a level added to the vocabulary and missing from the declaration fails here.
 *
 * Gap: this covers the one retired enum that migration reads. An enum setting whose declaration is
 * narrower than what its other readers accept is not detected here.
 */
import { describe, expect, it } from "bun:test";
import { resolveEffort, withLegacyDefaultEffort } from "@veyyon/coding-agent/config/effort-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CONFIGURED_THINKING_LEVELS } from "@veyyon/coding-agent/thinking";

const MODEL_SELECTOR = "anthropic/claude-sonnet-4-5";

describe("a retired defaultThinkingLevel reads back as written", () => {
	for (const level of CONFIGURED_THINKING_LEVELS) {
		it(level, () => {
			const settings = Settings.isolated({ defaultThinkingLevel: level });

			expect(settings.get("defaultThinkingLevel")).toBe(level);
			expect(
				resolveEffort({
					modelSelector: MODEL_SELECTOR,
					defaultEffort: withLegacyDefaultEffort(undefined, settings.get("defaultThinkingLevel")),
				}),
			).toEqual({ level, source: "any-row" });
		});
	}
});
