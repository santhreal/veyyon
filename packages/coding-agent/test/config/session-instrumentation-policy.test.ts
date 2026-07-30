import { describe, expect, it } from "bun:test";
import {
	allowsSessionTelemetry,
	type InstrumentationLevel,
	type SessionTelemetryCategory,
	sessionTelemetryDetail,
} from "@veyyon/ai/instrumentation";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getDefault, getEnumValues } from "@veyyon/coding-agent/config/settings-schema";

const categories = [
	"lifecycle",
	"context-breakdown",
	"tool-span",
	"agent-communication",
	"goal-verification",
	"analytics-rollup",
] as const satisfies readonly SessionTelemetryCategory[];

const expectedDetail = {
	off: ["none", "none", "none", "none", "none", "none"],
	basic: ["basic", "none", "basic", "none", "basic", "none"],
	rich: ["rich", "rich", "rich", "rich", "rich", "rich"],
	ultra: ["ultra", "ultra", "ultra", "ultra", "ultra", "ultra"],
} as const satisfies Record<InstrumentationLevel, readonly string[]>;

describe("session instrumentation policy", () => {
	it("keeps the persisted setting vocabulary and default unchanged", () => {
		expect(getEnumValues("session.instrumentation")).toEqual(["off", "basic", "rich", "ultra"]);
		expect(getDefault("session.instrumentation")).toBe("off");
	});

	for (const level of ["off", "basic", "rich", "ultra"] as const) {
		it(`${level} configs round-trip and enforce their category detail`, () => {
			const settings = Settings.isolated({ "session.instrumentation": level });
			expect(settings.get("session.instrumentation")).toBe(level);

			const details = categories.map(category => sessionTelemetryDetail(level, category));
			expect(details).toEqual([...expectedDetail[level]]);
			expect(categories.map(category => allowsSessionTelemetry(level, category))).toEqual(
				details.map(detail => detail !== "none"),
			);
		});
	}

	it("fails closed for absent and unknown runtime levels", () => {
		for (const category of categories) {
			expect(sessionTelemetryDetail(undefined, category)).toBe("none");
			expect(allowsSessionTelemetry("invalid" as InstrumentationLevel, category)).toBe(false);
		}
	});
});
