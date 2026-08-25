/**
 * `/memory view` has to show BOTH halves of the payload: the stable system
 * instructions and the volatile recall block. A volatile read that throws
 * must not look like an empty memory.
 *
 * WHY THIS SUITE EXISTS. `buildMemoryPayloadForDisplay` joins the two pieces
 * with a blank line. The catch around `buildVolatileContext` pushes a markdown
 * italic naming the error rather than swallowing it. A viewer that showed
 * only the system-prompt half would report "nothing recalled" for a session
 * whose recalled memories are the entire point — the failure this function
 * exists to prevent.
 *
 * The double here is a backend object, not a mock library: the production
 * function is the thing under test.
 */
import { describe, expect, it } from "bun:test";
import { buildMemoryPayloadForDisplay } from "@veyyon/coding-agent/memory-backend/payload";
import type { MemoryBackend } from "@veyyon/coding-agent/memory-backend/types";
import { Settings } from "@veyyon/coding-agent/config/settings";

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

	it("returns only the stable instructions when there is no session to recall against", async () => {
		const settings = Settings.isolated();
		const out = await buildMemoryPayloadForDisplay(
			backend({
				id: "local",
				async buildDeveloperInstructions() {
					return "STABLE INSTRUCTIONS";
				},
				async buildVolatileContext() {
					return "MUST NOT RUN WITHOUT A SESSION";
				},
			}),
			"/tmp/agent",
			settings,
		);
		expect(out).toBe("STABLE INSTRUCTIONS");
		expect(out).not.toContain("MUST NOT RUN");
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

	it("still shows the volatile half when the stable half is empty", async () => {
		const settings = Settings.isolated();
		const session = {} as never;
		const out = await buildMemoryPayloadForDisplay(
			backend({
				id: "mnemopi",
				async buildDeveloperInstructions() {
					return "   \n";
				},
				async buildVolatileContext() {
					return "ONLY RECALL";
				},
			}),
			"/tmp/agent",
			settings,
			session,
		);
		expect(out).toBe("ONLY RECALL");
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

	it("does not return undefined when only the volatile half failed", async () => {
		const settings = Settings.isolated();
		const session = {} as never;
		const out = await buildMemoryPayloadForDisplay(
			backend({
				id: "local",
				async buildDeveloperInstructions() {
					return undefined;
				},
				async buildVolatileContext() {
					throw new Error("recall timeout");
				},
			}),
			"/tmp/agent",
			settings,
			session,
		);
		expect(out).toBeDefined();
		expect(out).toMatch(/recall timeout/);
	});

	it("trims whitespace-only volatile context rather than joining a blank block", async () => {
		const settings = Settings.isolated();
		const session = {} as never;
		const out = await buildMemoryPayloadForDisplay(
			backend({
				id: "local",
				async buildDeveloperInstructions() {
					return "STABLE";
				},
				async buildVolatileContext() {
					return "  \n\t  ";
				},
			}),
			"/tmp/agent",
			settings,
			session,
		);
		expect(out).toBe("STABLE");
	});
});
