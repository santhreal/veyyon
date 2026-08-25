/**
 * `/memory view` has to show BOTH halves of the payload. A volatile read
 * that throws must not look like an empty memory.
 *
 * `buildMemoryPayloadForDisplay` joins the two pieces with a blank line.
 * The catch around `buildVolatileContext` pushes a markdown italic naming
 * the error rather than swallowing it.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildMemoryPayloadForDisplay } from "@veyyon/coding-agent/memory-backend/payload";
import type { MemoryBackend } from "@veyyon/coding-agent/memory-backend/types";

function backend(partial: Partial<MemoryBackend> & Pick<MemoryBackend, "id">): MemoryBackend {
	return {
		start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear() {},
		async enqueue() {},
		...partial,
	} as MemoryBackend;
}

describe("buildMemoryPayloadForDisplay joins both halves and never swallows a volatile failure", () => {
	it("returns undefined when the backend contributes nothing", async () => {
		const settings = Settings.isolated();
		const out = await buildMemoryPayloadForDisplay(backend({ id: "off" }), "/tmp/agent", settings);
		expect(out).toBeUndefined();
	});

	it("joins stable instructions and volatile recall with a blank line", async () => {
		const settings = Settings.isolated();
		const session = {} as never;
		const out = await buildMemoryPayloadForDisplay(
			backend({
				id: "local",
				async buildDeveloperInstructions() {
					return "STABLE INSTRUCTIONS\n";
				},
				async buildVolatileContext() {
					return "\nRECALLED MEMORY\n";
				},
			}),
			"/tmp/agent",
			settings,
			session,
		);
		expect(out).toBe("STABLE INSTRUCTIONS\n\nRECALLED MEMORY");
	});

	it("renders a volatile throw as an operator-visible italic instead of dropping the payload", async () => {
		const settings = Settings.isolated();
		const session = {} as never;
		const out = await buildMemoryPayloadForDisplay(
			backend({
				id: "hindsight",
				async buildDeveloperInstructions() {
					return "STABLE";
				},
				async buildVolatileContext() {
					throw new Error("bank locked");
				},
			}),
			"/tmp/agent",
			settings,
			session,
		);
		expect(out).toContain("STABLE");
		expect(out).toMatch(/could not be read/i);
		expect(out).toContain("bank locked");
		expect(out).not.toBe("STABLE");
	});
});
