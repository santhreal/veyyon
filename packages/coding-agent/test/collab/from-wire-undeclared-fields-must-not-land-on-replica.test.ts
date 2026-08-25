/**
 * fromWire* spreads the wire object, so undeclared keys a peer stuffed on
 * the frame land on the replica session file. toWire is field-by-field;
 * fromWire must be too.
 */
import { describe, expect, it } from "bun:test";
import {
	fromWireAgentEvent,
	fromWireSessionEntry,
	toWireSessionEntry,
	WIRE_API_UNREPORTED,
} from "@veyyon/coding-agent/collab/protocol";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";

function assistantEntry(): SessionEntry {
	return {
		type: "message",
		id: "01JZQ4VN2M7X8P0R5T9K3B6C2D",
		parentId: "01JZQ4VN2M7X8P0R5T9K3B6C2C",
		timestamp: "2026-07-26T11:02:03.004Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "the relay is up" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			usage: {
				input: 1200,
				output: 340,
				cacheRead: 800,
				cacheWrite: 64,
				totalTokens: 2404,
				cost: { total: 0.0412 },
			},
			stopReason: "stop",
			timestamp: 1_785_000_123_004,
		},
	} as unknown as SessionEntry;
}

describe("fromWireSessionEntry drops undeclared keys a peer stuffed onto the frame", () => {
	it("does not keep a top-level undeclared own-key from the wire object", () => {
		const wire = toWireSessionEntry(assistantEntry());
		if (!wire) throw new Error("expected a projected entry");
		const polluted = { ...wire, relaySecret: "do-not-persist", providerPayload: { raw: "host prompt" } };
		const back = fromWireSessionEntry(polluted as typeof wire) as unknown as Record<string, unknown>;
		expect(Object.hasOwn(back, "relaySecret")).toBe(false);
		expect(Object.hasOwn(back, "providerPayload")).toBe(false);
		expect(JSON.stringify(back)).not.toContain("do-not-persist");
	});

	it("does not keep an undeclared own-key on the assistant message object", () => {
		const wire = toWireSessionEntry(assistantEntry());
		if (!wire) throw new Error("expected a projected entry");
		const message = {
			...((wire as unknown as { message: Record<string, unknown> }).message),
			stolen: true,
			request: { temperature: 0 },
		};
		const back = fromWireSessionEntry({ ...(wire as object), message } as never) as unknown as {
			message: Record<string, unknown>;
		};
		expect(Object.hasOwn(back.message, "stolen")).toBe(false);
		expect(Object.hasOwn(back.message, "request")).toBe(false);
		expect(back.message.api).toBe(WIRE_API_UNREPORTED);
	});

	it("invents api as the unreported marker, never echoing a peer-supplied endpoint name", () => {
		const wire = toWireSessionEntry(assistantEntry());
		if (!wire) throw new Error("expected a projected entry");
		const message = {
			...((wire as unknown as { message: Record<string, unknown> }).message),
			api: "anthropic-messages",
		};
		const back = fromWireSessionEntry({ ...(wire as object), message } as never) as unknown as {
			message: { api: string };
		};
		expect(back.message.api).toBe(WIRE_API_UNREPORTED);
	});
});

describe("fromWireAgentEvent drops undeclared keys on assistant message_* events", () => {
	it("does not keep stolen keys on message_update", () => {
		const event = {
			type: "message_update" as const,
			message: {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "partial" }],
				provider: "anthropic",
				model: "claude-opus-4-6",
				stolenTurnMetrics: { toolCalls: 9 },
			},
		};
		const back = fromWireAgentEvent(event as never) as unknown as { message: Record<string, unknown> };
		expect(Object.hasOwn(back.message, "stolenTurnMetrics")).toBe(false);
		expect(back.message.api).toBe(WIRE_API_UNREPORTED);
	});
});
