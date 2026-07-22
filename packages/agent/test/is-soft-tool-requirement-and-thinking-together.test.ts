/**
 * Soft tool requirement + ThinkingLevel values coexist without coupling.
 */
import { describe, expect, it } from "bun:test";
import { isSoftToolRequirement } from "@veyyon/agent-core/types";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";

describe("soft tool + thinking coexistence", () => {
	it("soft requirement not confused with thinking levels", () => {
		expect(isSoftToolRequirement(ThinkingLevel.High as never)).toBe(false);
		expect(isSoftToolRequirement(ThinkingLevel.Off as never)).toBe(false);
		expect(
			isSoftToolRequirement({
				soft: true,
				id: "p",
				toolName: "resolve",
				reminder: [],
			}),
		).toBe(true);
	});

	it("ThinkingLevel keys are stable", () => {
		expect(ThinkingLevel.Inherit).toBe("inherit");
		expect(ThinkingLevel.Off).toBe("off");
	});
});
