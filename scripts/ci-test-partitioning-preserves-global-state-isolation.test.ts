/**
 * WHY: coding-agent test partitioning once classified native/tooling markers before
 * singleton markers. A global-state suite that also imported the native addon was then
 * batched with unrelated tests, where process-wide mutations could leak between files.
 * The singleton constraint must win every lower-priority collision.
 *
 * This covers the pure classification boundary. It does not prove that a test restores
 * the global state it mutates; the changed-suite leak tracer owns that contract.
 */
import { describe, expect, it } from "bun:test";
import { classifyCodingAgentTest } from "./ci-test-ts";

describe("coding-agent test partition precedence", () => {
	it("keeps every singleton-shaped collision in the isolated bucket", () => {
		const collisions = [
			{
				file: "test/config-native.test.ts",
				content: 'import "@veyyon/natives";\nSettings.init({});',
			},
			{
				file: "test/modes/global-state-render.test.ts",
				content: 'import "@veyyon/tui";\nBun.spawn(["helper"]);',
			},
			{
				file: "test/task/fake-timer-worker.test.ts",
				content: 'vi.useFakeTimers();\nnew Worker("helper.ts");',
			},
		] as const;

		for (const collision of collisions) {
			expect({
				file: collision.file,
				bucket: classifyCodingAgentTest(collision.file, collision.content),
			}).toEqual({ file: collision.file, bucket: "singleton" });
		}
	});

	it("does not treat ordinary prose containing native as a native-addon dependency", () => {
		expect(
			classifyCodingAgentTest(
				"test/task/executor-wall-clock.test.ts",
				"AgentSession keeps the native runtime behavior visible",
			),
		).toBe("runtime");
	});

	it("still assigns an actual native-addon import to the native bucket", () => {
		expect(classifyCodingAgentTest("test/plain-addon.test.ts", 'import "@veyyon/natives";')).toBe("native");
	});
});
