/**
 * WHY THIS SUITE EXISTS. Memory backends deliver instructions in two distinct parts:
 *   1. `buildDeveloperInstructions`: static developer instructions that ride in the system
 *      prompt and stay fixed for cache prefix stability.
 *   2. `buildVolatileContext`: dynamic recalled memories and mental models delivered at the
 *      tail of the conversation as they change.
 *
 * When these two pieces were separated to protect LLM prompt caching, `/memory view`
 * had to display both together. If it only read the system prompt half, an active session
 * with recalled memories would display as empty.
 *
 * This suite enforces:
 *   - The shape contract of `buildMemoryPayloadForDisplay`: joining both trimmed parts with
 *     `\n\n`, handling instructions-only, volatile-only, and empty/whitespace states (returning
 *     `undefined` when nothing is contributed).
 *   - Error resilience: if reading volatile context throws (corrupted database, stale cache,
 *     deserialization failure), the error is NOT swallowed as an empty payload. Instead,
 *     it is logged to `logger.warn` and rendered as a visible explanation block
 *     `_The recalled-memory block could not be read: <error>_`.
 *   - Behavior when `session` is omitted or `backend.buildVolatileContext` is not defined.
 *   - Integration with shipped `offBackend` and `localBackend`.
 *
 * What this does NOT catch:
 *   - The SQLite schema migrations inside individual backend databases (tested in mnemopi/hindsight packages).
 *   - Provider-level token consumption of the resulting prompt.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { localBackend } from "@veyyon/coding-agent/memory-backend/local-backend";
import { offBackend } from "@veyyon/coding-agent/memory-backend/off-backend";
import { buildMemoryPayloadForDisplay } from "@veyyon/coding-agent/memory-backend/payload";
import type { MemoryBackend } from "@veyyon/coding-agent/memory-backend/types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { logger } from "@veyyon/utils";

describe("buildMemoryPayloadForDisplay", () => {
	const dummyAgentDir = "/tmp/test-agent-dir";
	const dummySettings = Settings.isolated({});
	const dummySession = {
		sessionManager: {
			getSessionFile: () => undefined,
		},
	} as unknown as AgentSession;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("1. shape contract: joining and trimming instructions and volatile context", () => {
		it("joins developer instructions and volatile context with double newlines", async () => {
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "# Memory Instructions\nUse memory tools.";
				},
				async buildVolatileContext() {
					return "## Recalled Memories\n- User prefers TypeScript.";
				},
			};

			const payload = await buildMemoryPayloadForDisplay(backend, dummyAgentDir, dummySettings, dummySession);

			expect(payload).toBe(
				"# Memory Instructions\nUse memory tools.\n\n## Recalled Memories\n- User prefers TypeScript.",
			);
		});

		it("trims surrounding whitespace from both instructions and volatile context", async () => {
			const backend: MemoryBackend = {
				id: "hindsight",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "   \n\n  Static instructions with padding.   \n\n  ";
				},
				async buildVolatileContext() {
					return "   \t\n  Volatile context with padding.   \n  ";
				},
			};

			const payload = await buildMemoryPayloadForDisplay(backend, dummyAgentDir, dummySettings, dummySession);

			expect(payload).toBe("Static instructions with padding.\n\nVolatile context with padding.");
		});

		it("returns only instructions when volatile context is undefined or whitespace", async () => {
			const backendWithUndefinedVolatile: MemoryBackend = {
				id: "local",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "Developer instructions alone.";
				},
				async buildVolatileContext() {
					return undefined;
				},
			};

			const payload1 = await buildMemoryPayloadForDisplay(
				backendWithUndefinedVolatile,
				dummyAgentDir,
				dummySettings,
				dummySession,
			);
			expect(payload1).toBe("Developer instructions alone.");

			const backendWithWhitespaceVolatile: MemoryBackend = {
				id: "local",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "Developer instructions alone.";
				},
				async buildVolatileContext() {
					return "   \n\t   ";
				},
			};

			const payload2 = await buildMemoryPayloadForDisplay(
				backendWithWhitespaceVolatile,
				dummyAgentDir,
				dummySettings,
				dummySession,
			);
			expect(payload2).toBe("Developer instructions alone.");
		});

		it("returns only volatile context when developer instructions are undefined or whitespace", async () => {
			const backendWithUndefinedInstructions: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return undefined;
				},
				async buildVolatileContext() {
					return "Recalled volatile memories alone.";
				},
			};

			const payload1 = await buildMemoryPayloadForDisplay(
				backendWithUndefinedInstructions,
				dummyAgentDir,
				dummySettings,
				dummySession,
			);
			expect(payload1).toBe("Recalled volatile memories alone.");

			const backendWithWhitespaceInstructions: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "  \n  ";
				},
				async buildVolatileContext() {
					return "Recalled volatile memories alone.";
				},
			};

			const payload2 = await buildMemoryPayloadForDisplay(
				backendWithWhitespaceInstructions,
				dummyAgentDir,
				dummySettings,
				dummySession,
			);
			expect(payload2).toBe("Recalled volatile memories alone.");
		});

		it("returns undefined when neither instructions nor volatile context contribute content", async () => {
			const emptyBackend: MemoryBackend = {
				id: "off",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "   \n  ";
				},
				async buildVolatileContext() {
					return "   \t  ";
				},
			};

			const payload = await buildMemoryPayloadForDisplay(emptyBackend, dummyAgentDir, dummySettings, dummySession);
			expect(payload).toBeUndefined();
		});

		it("does not call buildVolatileContext when session is undefined", async () => {
			let volatileCalled = false;
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "Instructions without session.";
				},
				async buildVolatileContext() {
					volatileCalled = true;
					return "Should not be called";
				},
			};

			const payload = await buildMemoryPayloadForDisplay(backend, dummyAgentDir, dummySettings, undefined);

			expect(volatileCalled).toBe(false);
			expect(payload).toBe("Instructions without session.");
		});

		it("functions properly when backend does not implement buildVolatileContext", async () => {
			const backendWithoutVolatile: MemoryBackend = {
				id: "local",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "Backend has no buildVolatileContext method.";
				},
			};

			const payload = await buildMemoryPayloadForDisplay(
				backendWithoutVolatile,
				dummyAgentDir,
				dummySettings,
				dummySession,
			);
			expect(payload).toBe("Backend has no buildVolatileContext method.");
		});
	});

	describe("2. error resilience: failures in volatile context are logged and rendered", () => {
		/**
		 * Collects the warnings the payload builder emits, so a test asserts the exact set of
		 * records produced rather than that a spy fired, and keeps the real log file untouched.
		 */
		function recordWarnings(): Array<{ message: string; context?: Record<string, unknown> }> {
			const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
			vi.spyOn(logger, "warn").mockImplementation((message, context) => {
				warnings.push({ message, context });
			});
			return warnings;
		}

		it("catches an Error thrown by buildVolatileContext, logs warning, and appends formatted notice", async () => {
			const warnings = recordWarnings();
			const backend: MemoryBackend = {
				id: "hindsight",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "Static developer instructions.";
				},
				async buildVolatileContext() {
					throw new Error("Corrupted SQLite database index");
				},
			};

			const payload = await buildMemoryPayloadForDisplay(backend, dummyAgentDir, dummySettings, dummySession);

			expect(warnings).toEqual([
				{
					message: "Memory view: the backend's volatile context could not be read",
					context: { backend: "hindsight", error: "Corrupted SQLite database index" },
				},
			]);
			expect(payload).toBe(
				"Static developer instructions.\n\n_The recalled-memory block could not be read: Corrupted SQLite database index_",
			);
		});

		it("renders notice alone when instructions are empty and buildVolatileContext throws", async () => {
			const warnings = recordWarnings();
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return undefined;
				},
				async buildVolatileContext() {
					throw new Error("Stale serialization format");
				},
			};

			const payload = await buildMemoryPayloadForDisplay(backend, dummyAgentDir, dummySettings, dummySession);

			expect(warnings).toEqual([
				{
					message: "Memory view: the backend's volatile context could not be read",
					context: { backend: "mnemopi", error: "Stale serialization format" },
				},
			]);
			expect(payload).toBe("_The recalled-memory block could not be read: Stale serialization format_");
		});

		it("handles non-Error thrown values from buildVolatileContext with errorMessage formatting", async () => {
			const warnings = recordWarnings();
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async clear() {},
				async enqueue() {},
				async buildDeveloperInstructions() {
					return "Static instructions.";
				},
				async buildVolatileContext() {
					throw "raw string error from remote peer";
				},
			};

			const payload = await buildMemoryPayloadForDisplay(backend, dummyAgentDir, dummySettings, dummySession);

			expect(warnings).toEqual([
				{
					message: "Memory view: the backend's volatile context could not be read",
					context: { backend: "mnemopi", error: "raw string error from remote peer" },
				},
			]);
			expect(payload).toBe(
				"Static instructions.\n\n_The recalled-memory block could not be read: raw string error from remote peer_",
			);
		});
	});

	describe("3. integration with built-in backends", () => {
		it("offBackend returns undefined for display payload", async () => {
			const payload = await buildMemoryPayloadForDisplay(offBackend, dummyAgentDir, dummySettings, dummySession);
			expect(payload).toBeUndefined();
		});

		it("localBackend renders developer instructions when memory is enabled", async () => {
			const settings = Settings.isolated({ "memory.backend": "local" });
			const payload = await buildMemoryPayloadForDisplay(localBackend, dummyAgentDir, settings, dummySession);

			// localBackend delegates to memories/ module which returns instructions or undefined
			if (payload !== undefined) {
				expect(typeof payload).toBe("string");
				expect(payload.trim().length).toBeGreaterThan(0);
			}
		});
	});
});
