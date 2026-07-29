/**
 * Which display walk may rewrite a thinking block, and which must not.
 *
 * WHY THIS SUITE EXISTS. Two codecs share one walk over assistant content: the
 * secret obfuscator turning `#HASH#` back into a real value, and argot turning
 * `§db` back into `src/db.ts`. They look interchangeable and they are not, on
 * exactly one block type.
 *
 * A thinking block is replayed to the provider with a `thinkingSignature` bound
 * to its exact bytes. The deobfuscated transcript is fed back as the starting
 * messages on resume, so rewriting thinking there would send back text whose
 * signature no longer matches and the next request would be rejected. Argot's
 * expansion is only ever rendered and then dropped, so it has no such
 * constraint, and it does have the opposite obligation: the live stream already
 * decodes thinking, so leaving the finished message raw made the model's
 * reasoning flip from `src/db.ts` back to `§db` the instant it stopped writing.
 *
 * The two halves are pinned together, in one place, because the risk is that a
 * later change "fixes the inconsistency" by making both walks behave the same.
 * Either direction of that is a bug, and one of them breaks resume in a way no
 * local test would otherwise catch.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { expandAssistantContent, expandSessionContext } from "@veyyon/coding-agent/argot-wire";
import { deobfuscateAssistantContent, SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import type { SessionContext } from "@veyyon/coding-agent/session/session-context";
import { ArgotSession, type Vocabulary } from "argot";

const SECRET = "sk-live-9f3a7c21b8e4";

function loadedCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([["db", "src/db.ts"]]),
		meta: new Map(),
	};
	const codec = new ArgotSession();
	codec.loadVocab(vocab);
	return codec;
}

/** Content with the same marker in a thinking block and in a text block. */
function content(marker: string): AssistantMessage["content"] {
	return [
		{ type: "thinking", thinking: `I should open ${marker}`, thinkingSignature: "sig-abc" },
		{ type: "text", text: `Opening ${marker}` },
	] as AssistantMessage["content"];
}

/** The thinking and text of a walked content array. */
function readBoth(walked: AssistantMessage["content"]): { thinking: string; text: string } {
	const thinking = walked.find(b => b.type === "thinking");
	const text = walked.find(b => b.type === "text");
	return {
		thinking: thinking?.type === "thinking" ? thinking.thinking : "",
		text: text?.type === "text" ? text.text : "",
	};
}

describe("argot display walk", () => {
	/**
	 * The regression this suite was written for. The model reasons in handles just
	 * as it writes in them, and a person reading the reasoning pane has the same
	 * claim on seeing the expansion.
	 */
	it("expands a handle in thinking as well as in text", () => {
		const walked = expandAssistantContent(loadedCodec(), content("§db"));
		expect(readBoth(walked)).toEqual({ thinking: "I should open src/db.ts", text: "Opening src/db.ts" });
	});

	/**
	 * The signature is provider-replay data, not prose. Rewriting the thinking text
	 * for display is fine; rewriting the signature that authenticates it never is.
	 */
	it("leaves the thinking signature byte-identical while rewriting the thinking text", () => {
		const walked = expandAssistantContent(loadedCodec(), content("§db"));
		const thinking = walked.find(b => b.type === "thinking");
		expect(thinking).toMatchObject({ thinkingSignature: "sig-abc" });
	});

	/** The transcript walk used for the rebuilt TUI view and for export agrees with the message walk. */
	it("expands thinking across a rebuilt transcript too", () => {
		const context = {
			messages: [{ role: "assistant", content: content("§db"), timestamp: 0 }],
		} as unknown as SessionContext;
		const walked = expandSessionContext(loadedCodec(), context);
		const message = walked.messages[0];
		if (message?.role !== "assistant") throw new Error("expected an assistant message");
		expect(readBoth(message.content).thinking).toBe("I should open src/db.ts");
	});

	/** Nothing to expand means the same reference back, so an untouched render allocates nothing. */
	it("returns the same content reference when no handle appears", () => {
		const original = content("src/main.ts");
		expect(expandAssistantContent(loadedCodec(), original)).toBe(original);
	});
});

describe("secret deobfuscation walk", () => {
	/**
	 * The negative twin, and the one that matters most. This walk's output is fed
	 * back to the provider on resume, so the thinking bytes it returns must be the
	 * bytes the signature was issued for. A placeholder left visible in the
	 * reasoning pane is the deliberate cost of that.
	 */
	it("restores a secret in text but leaves thinking untouched, so replay stays valid", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		expect(placeholder).not.toBe(SECRET);

		const walked = deobfuscateAssistantContent(obfuscator, content(placeholder));
		const both = readBoth(walked);
		expect(both.text).toBe(`Opening ${SECRET}`);
		expect(both.thinking).toBe(`I should open ${placeholder}`);
		expect(both.thinking).not.toContain(SECRET);
	});

	/** With no secrets configured the walk is identity, not a copy. */
	it("returns the same content reference when no secrets are configured", () => {
		const original = content("nothing here");
		expect(deobfuscateAssistantContent(new SecretObfuscator([]), original)).toBe(original);
	});
});
