import { describe, expect, it } from "bun:test";
import { getUi, SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";

describe("session.workdir settings UI", () => {
	it("exposes string type with tab/group/label for the settings UI", () => {
		const definition = SETTINGS_SCHEMA["session.workdir"];
		expect(definition).toBeDefined();
		expect(definition.type).toBe("string");

		const ui = getUi("session.workdir");
		expect(ui).toBeDefined();
		expect(ui?.tab).toBe("interaction");
		expect(ui?.group).toBe("Profile");
		expect(ui?.label).toBe("Default Working Directory");
		expect(typeof ui?.description).toBe("string");
		expect((ui?.description ?? "").length).toBeGreaterThan(0);
	});
});
