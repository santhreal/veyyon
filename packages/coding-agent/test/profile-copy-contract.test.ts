import { describe, expect, it } from "bun:test";
import { PROFILE_COPY_ITEMS } from "@veyyon/coding-agent/cli/profile-cli";

describe("profile copy contract", () => {
	/**
	 * The instruction picker represents one portable file, AGENTS.md. This locks
	 * out the old mislabeled row that also moved system and sticky-rule files.
	 */
	it("offers exactly AGENTS.md in the agent-instructions row", () => {
		const agents = PROFILE_COPY_ITEMS.find(item => item.key === "agents");
		expect(agents?.label).toBe("AGENTS.md");
		expect(agents?.files).toEqual(["AGENTS.md"]);
		expect(agents?.dirs).toBeUndefined();
	});

	/**
	 * RULES.md is profile-local policy that can move only through settings or a
	 * manual file operation. No other picker row may silently reintroduce it.
	 */
	it("never carries removed system files or RULES.md during a profile switch", () => {
		const copiedFiles = PROFILE_COPY_ITEMS.flatMap(item => item.files ?? []);
		expect(copiedFiles).not.toContain("SYSTEM.md");
		expect(copiedFiles).not.toContain("APPEND_SYSTEM.md");
		expect(copiedFiles).not.toContain("RULES.md");
	});
});
