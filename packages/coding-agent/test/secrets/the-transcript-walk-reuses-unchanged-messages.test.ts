/**
 * The transcript walk must hand back the SAME objects when it changed nothing.
 *
 * WHY THIS SUITE EXISTS. `deobfuscateSessionContext` decides whether a session context was
 * modified with `messages === sessionContext.messages`, and returns the caller's own context
 * object when the answer is no. That reference comparison is the whole short-circuit: a session
 * with no secrets in it must not be rebuilt on every display pass. The comparison is only correct
 * because each layer underneath it preserves identity too. `mapAgentMessageStrings` returns the
 * input array unless some message changed, and the per-message block walk returns the input block
 * array unless some block's text changed.
 *
 * That innermost block walk was an exported function with no caller outside this module, so it
 * looked like a utility anyone could rewrite. It is not a utility: it is one link in an identity
 * chain, and "simplifying" it to always `map` into a fresh array would keep every value assertion
 * in the existing suites green while silently making every transcript render reallocate the whole
 * message list and defeat the `===` short-circuit above it. It is module-private now, and this
 * suite pins the contract that made it worth keeping rather than deleting.
 *
 * THE VALUE ASSERTIONS ARE NOT THE POINT HERE. Restoring block text is already covered in
 * `test/secrets-obfuscator.test.ts`. Everything below asserts reference identity, positively
 * (unchanged input is handed straight back) and negatively (a real change does allocate, and only
 * where it had to).
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	deobfuscateSessionContext,
	mapAgentMessageStrings,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";
import type { SessionContext } from "@veyyon/coding-agent/session/session-context";

const SECRET = "WALK_IDENTITY_SECRET_TOKEN_9182";

/** A compaction summary carrying both a text block and an opaque image block. */
function compactionWith(summaryText: string, blockText: string, imageData: string): AgentMessage {
	return {
		role: "compactionSummary",
		summary: summaryText,
		tokensBefore: 0,
		blocks: [
			{ type: "text", text: blockText },
			{ type: "image", data: imageData, mimeType: "image/png" },
		],
		timestamp: 1,
	};
}

/** The smallest session context the display-restore seam accepts. */
function contextWith(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		models: { default: "anthropic/claude-opus-4" },
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

describe("an unchanged transcript is handed back untouched", () => {
	/**
	 * Identity all the way down when the mapper is a no-op.
	 *
	 * This is the exact condition every session without secrets in its transcript hits on every
	 * display pass. Losing it turns a free comparison into a full transcript copy per render.
	 */
	it("returns the same array, the same message, and the same block array", () => {
		const image = { type: "image", data: "frame-bytes==", mimeType: "image/png" } as const;
		const message: AgentMessage = {
			role: "compactionSummary",
			summary: "nothing to restore",
			tokensBefore: 0,
			blocks: [{ type: "text", text: "archived line" }, image],
			timestamp: 1,
		};
		const messages = [message];

		const walked = mapAgentMessageStrings(messages, text => text);

		expect(walked).toBe(messages);
		expect(walked[0]).toBe(message);
		const blocks = walked[0].role === "compactionSummary" ? walked[0].blocks : undefined;
		expect(blocks).toBe(message.role === "compactionSummary" ? message.blocks : undefined);
	});

	/**
	 * The seam that depends on the identity chain returns the caller's own context object.
	 *
	 * `deobfuscateSessionContext` spreads a new context only when the messages changed. A walk that
	 * always allocated would make this spread happen on every call, so this test is the top of the
	 * chain the private block walk sits at the bottom of.
	 */
	it("gives back the identical SessionContext when no placeholder was present", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const context = contextWith([compactionWith("plain summary", "plain archived line", "frame-bytes==")]);

		const restored = deobfuscateSessionContext(context, obfuscator);

		expect(restored).toBe(context);
		expect(restored.messages).toBe(context.messages);
	});
});

describe("a changed transcript allocates only where it had to", () => {
	/**
	 * A real substitution produces new objects, so the identity check above cannot pass vacuously.
	 *
	 * Without this negative twin, a walk that returned the input unconditionally would satisfy every
	 * identity assertion in this file while never restoring anything at all.
	 */
	it("returns a new array and a new block array when a block's text is restored", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		const message = compactionWith("plain summary", `archived ${placeholder}`, "frame-bytes==");
		const messages = [message];

		const walked = mapAgentMessageStrings(messages, text => obfuscator.deobfuscate(text));

		expect(walked).not.toBe(messages);
		expect(walked[0]).not.toBe(message);
		if (walked[0].role !== "compactionSummary" || message.role !== "compactionSummary") {
			throw new Error("the walk changed the role of a compaction summary");
		}
		expect(walked[0].blocks).not.toBe(message.blocks);
		const restoredBlock = walked[0].blocks?.[0];
		expect(restoredBlock?.type === "text" && restoredBlock.text).toBe(`archived ${SECRET}`);
	});

	/**
	 * Untouched blocks and untouched messages keep their references across a real change.
	 *
	 * The allocation is per-block and per-message, not per-transcript. An image block holds opaque
	 * bytes that must never be rewritten, and reusing its reference is the cheapest possible proof
	 * that nothing rewrote it. A user message beside the changed one is persisted literally and is
	 * never walked at all.
	 */
	it("reuses the image block and the neighbouring user message that did not change", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		const userMessage: AgentMessage = {
			role: "user",
			content: `operator typed ${placeholder} literally`,
			timestamp: 1,
		};
		const message = compactionWith("plain summary", `archived ${placeholder}`, "frame-bytes==");
		const originalImage = message.role === "compactionSummary" ? message.blocks?.[1] : undefined;

		const walked = mapAgentMessageStrings([userMessage, message], text => obfuscator.deobfuscate(text));

		expect(walked[0]).toBe(userMessage);
		const changed = walked[1];
		if (changed.role !== "compactionSummary") throw new Error("the walk changed the role of a compaction summary");
		expect(changed.blocks?.[1]).toBe(originalImage);
	});

	/**
	 * A summary change alone must not force the block array to be rebuilt.
	 *
	 * The compaction branch maps three things independently (summary, short summary, blocks). If the
	 * block walk stopped short-circuiting, this case would allocate a fresh block array for a change
	 * that never touched a block.
	 */
	it("keeps the block array identical when only the summary text changed", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		const message = compactionWith(`summary ${placeholder}`, "archived plain line", "frame-bytes==");
		const originalBlocks = message.role === "compactionSummary" ? message.blocks : undefined;

		const [walked] = mapAgentMessageStrings([message], text => obfuscator.deobfuscate(text));

		if (walked.role !== "compactionSummary") throw new Error("the walk changed the role of a compaction summary");
		expect(walked.summary).toBe(`summary ${SECRET}`);
		expect(walked.blocks).toBe(originalBlocks);
	});
});
