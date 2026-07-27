import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, TextContent, UserMessage } from "@veyyon/ai";
import { wrapSteeringForModel } from "@veyyon/coding-agent/session/steering-envelope";

/**
 * Contracts: a steering message's wire bytes are a pure function of the message, not of its position.
 *
 * WHY THIS SUITE EXISTS. `wrapSteeringForModel` moved out of `session/messages.ts` because it was the
 * only code there that renders a PROMPT, and `prompts/registry.ts` is the deliberate single owner of all
 * 143 prompt files: 238 modules, for one envelope template. `session/messages.ts` is imported by
 * `session/session-context.ts` and through it by `session/session-manager.ts`, which 206 test files
 * import, so that one template was priced into most of the suite. The function is unchanged; what
 * changed is which module it lives in.
 *
 * WHAT THE FUNCTION IS FOR, and the bug it locks out. A steering message is something the user typed
 * while a turn was already running. It is sent to the model inside an interjection envelope so the model
 * can tell it apart from an ordinary turn. An earlier version wrapped only the TRAILING run of steering
 * messages, and that made the bytes depend on position: the same persisted message went out enveloped
 * while it was the tail and raw once an assistant reply buried it. Rewriting already-cached prefix bytes
 * busts the provider's prompt cache from that message onward, on every later turn, and nothing about the
 * output looks wrong while it happens. So every steering message is wrapped, wherever it sits.
 *
 * The cases below assert the exact envelope text around the content rather than "it changed", because
 * "the message was transformed somehow" is satisfied by a transform that varies with position, which is
 * the defect.
 */

function userMessage(content: string, steering?: true): UserMessage {
	return steering ? ({ role: "user", content, steering } as UserMessage) : ({ role: "user", content } as UserMessage);
}

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function contentOf(message: AgentMessage | undefined): string {
	const content = (message as UserMessage | undefined)?.content;
	if (typeof content === "string") return content;
	const first = (content as (TextContent | ImageContent)[] | undefined)?.[0];
	return first && first.type === "text" ? first.text : "";
}

describe("wrapSteeringForModel", () => {
	/**
	 * The envelope itself, as rendered. Pinned as an exact containment rather than an equality so the
	 * template can gain wording, but the CONTENT has to be inside it and the message has to have been
	 * rewritten at all.
	 */
	it("wraps a steering message and keeps its text inside the envelope", () => {
		const wrapped = wrapSteeringForModel([userMessage("stop and check the tests", true)]);

		const text = contentOf(wrapped[0]);
		expect(text).not.toBe("stop and check the tests");
		expect(text).toContain("stop and check the tests");
		expect(text.length).toBeGreaterThan("stop and check the tests".length);
	});

	/**
	 * THE POSITION INDEPENDENCE, which is the whole contract. The same steering message buried behind an
	 * assistant reply must produce byte-identical content to the same message as the tail. This is the
	 * case that fails if anyone reintroduces "wrap only the trailing run", and it is the one the prompt
	 * cache depends on.
	 */
	it("produces the same bytes whether the steering message is the tail or buried", () => {
		const asTail = wrapSteeringForModel([userMessage("first"), userMessage("interject", true)]);
		const buried = wrapSteeringForModel([
			userMessage("first"),
			userMessage("interject", true),
			assistantMessage("ok"),
			userMessage("next turn"),
		]);

		expect(contentOf(buried[1])).toBe(contentOf(asTail[1]));
	});

	/** Every steering message in an array is wrapped, not just one of them. */
	it("wraps every steering message in the array", () => {
		const wrapped = wrapSteeringForModel([
			userMessage("one", true),
			assistantMessage("ok"),
			userMessage("two", true),
		]);

		expect(contentOf(wrapped[0])).toContain("one");
		expect(contentOf(wrapped[0])).not.toBe("one");
		expect(contentOf(wrapped[2])).toContain("two");
		expect(contentOf(wrapped[2])).not.toBe("two");
	});

	/**
	 * The `steering` marker is REMOVED from the wrapped message. It is a local flag about how the message
	 * arrived; leaving it on a message already carrying the envelope is how a second pass would wrap an
	 * enveloped message inside another envelope.
	 */
	it("drops the steering marker once the envelope is applied", () => {
		const wrapped = wrapSteeringForModel([userMessage("interject", true)]);

		expect((wrapped[0] as UserMessage & { steering?: true }).steering).toBeUndefined();
	});

	/** Idempotent for that reason: wrapping twice is wrapping once. */
	it("is idempotent, because the marker is gone after the first pass", () => {
		const once = wrapSteeringForModel([userMessage("interject", true)]);
		const twice = wrapSteeringForModel(once);

		expect(contentOf(twice[0])).toBe(contentOf(once[0]));
	});

	/**
	 * Non-steering messages are returned by IDENTITY, and so is the array when nothing needed wrapping.
	 * `sdk.ts` passes this as its context transformer on every turn, so an unconditional copy would
	 * allocate a new array and new objects for every message on every turn of every session.
	 */
	it("returns the same array and the same objects when nothing is steering", () => {
		const messages: AgentMessage[] = [userMessage("plain"), assistantMessage("reply")];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).toBe(messages);
		expect(wrapped[0]).toBe(messages[0]);
	});

	/** And the untouched neighbours keep their identity even when a sibling is wrapped. */
	it("leaves non-steering neighbours untouched when one message is wrapped", () => {
		const plain = userMessage("plain");
		const messages: AgentMessage[] = [plain, userMessage("interject", true)];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).toBe(plain);
	});

	/**
	 * An EMPTY steering message is left alone. Rendering the envelope around nothing sends the model an
	 * interjection that says a user interrupted to say nothing at all, which is worse than dropping the
	 * marker: it spends prompt bytes stating a fact that is not one.
	 */
	it("leaves an empty steering message unwrapped", () => {
		const empty = userMessage("", true);

		const wrapped = wrapSteeringForModel([empty]);

		expect(wrapped[0]).toBe(empty);
	});

	/**
	 * Array content: the text block is enveloped and the IMAGES survive. An image the user attached to an
	 * interjection is part of what they were pointing at, and the wrap rebuilds the content array, so it
	 * is exactly where a block would go missing.
	 */
	it("envelopes the text of array content and keeps the images", () => {
		const image = { type: "image", data: "AAAA", mediaType: "image/png" } as unknown as ImageContent;
		const message = {
			role: "user",
			content: [{ type: "text", text: "look at this" }, image],
			steering: true,
		} as UserMessage;

		const wrapped = wrapSteeringForModel([message]);

		const content = (wrapped[0] as UserMessage).content as (TextContent | ImageContent)[];
		expect(content).toHaveLength(2);
		expect(content[0].type).toBe("text");
		expect((content[0] as TextContent).text).toContain("look at this");
		expect((content[0] as TextContent).text).not.toBe("look at this");
		expect(content[1]).toBe(image);
	});

	/**
	 * Array content whose text is empty is left alone for the same reason as the string case, and the
	 * image-only interjection is the real shape of it: a user pasting a screenshot with no words.
	 */
	it("leaves an image-only steering message unwrapped", () => {
		const image = { type: "image", data: "AAAA", mediaType: "image/png" } as unknown as ImageContent;
		const message = { role: "user", content: [image], steering: true } as UserMessage;

		expect(wrapSteeringForModel([message])[0]).toBe(message);
	});

	/** An empty array of messages is an empty array, not a throw. */
	it("handles an empty message list", () => {
		expect(wrapSteeringForModel([])).toEqual([]);
	});
});
