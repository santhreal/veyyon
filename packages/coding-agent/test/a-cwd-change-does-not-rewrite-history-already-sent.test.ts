/**
 * WHY THIS SUITE EXISTS.
 *
 * Outbound wire-path canonicalization renders absolute paths under the session's
 * root as root-relative, and `ProviderContextCanonicalizer` memoizes that work per
 * source message so an append-mostly history is only rendered once. The provider
 * prompt cache depends on the same property from the other side: a request reuses
 * the cached prefix only while the bytes of the earlier messages are identical to
 * the bytes already sent.
 *
 * Two changes collided here. Roots used to accumulate, so a `cd` produced a
 * superset and re-rendering old messages happened to reproduce the same bytes.
 * That accumulation also made two distinct directories both render as `.`, which
 * is the defect fixed by relativizing against the active cwd only — and with a
 * single root, re-rendering an old message under a NEW cwd does not reproduce its
 * bytes. `transform` discarded its whole memo whenever the roots array changed, so
 * one `set_cwd` rewrote every earlier message and dropped the cached prefix.
 *
 * WHAT THIS SUITE DEFENDS.
 *
 * 1. A message already canonicalized keeps the exact bytes it was canonicalized
 *    with after the roots change — for every message role the relativizer rewrites.
 * 2. The memo prefix is reused rather than rebuilt: the earlier entries of the
 *    output are the same objects, which is what a re-render would break first.
 * 3. Messages appended after the change render against the NEW cwd.
 * 4. Only one directory is ever relative in a single rendering, so the defect the
 *    single-root change fixed stays fixed across a cwd change.
 *
 * WHAT THIS DOES NOT CATCH.
 *
 * Whether a provider actually honors the prefix — that is the provider's cache
 * behavior, observable only in billing. It also does not catch a caller that hands
 * the canonicalizer a fresh array of the SAME roots on every request; that costs a
 * relativizer rebuild but changes no bytes, so nothing here can see it.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@veyyon/ai";
import type { ToolCallIdMap } from "@veyyon/coding-agent/session/canonicalize-tool-call-ids";
import { ProviderContextCanonicalizer } from "@veyyon/coding-agent/session/provider-context-canonicalizer";
import { normalizeRoots } from "@veyyon/coding-agent/session/relativize-paths";
import { SET_CWD_TOOL_NAME } from "@veyyon/coding-agent/tools/reroot-hint";

const OLD_CWD = "/srv/checkout/alpha";
const NEW_CWD = "/srv/checkout/beta";

function createCanonicalizer(): ProviderContextCanonicalizer {
	const map: ToolCallIdMap = new Map();
	let counter = 0;
	return new ProviderContextCanonicalizer(map, () => {
		counter += 1;
		return `tc_${counter}`;
	});
}

const TIMESTAMP = 1_756_080_000;

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: TIMESTAMP };
}

function userBlocks(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: TIMESTAMP };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: TIMESTAMP,
	};
}

function toolResult(text: string, toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: TIMESTAMP,
	};
}

/** The move itself, which the relativizer must leave alone: it names both ends. */
function setCwdResult(text: string, toolCallId: string): ToolResultMessage {
	return { ...toolResult(text, toolCallId), toolName: SET_CWD_TOOL_NAME };
}

/** Every message role the relativizer rewrites, each carrying a path under OLD_CWD. */
const HISTORY_BY_ROLE: ReadonlyArray<{ role: string; message: Message }> = [
	{ role: "user (string content)", message: user(`read ${OLD_CWD}/src/main.ts please`) },
	{ role: "user (block content)", message: userBlocks(`also ${OLD_CWD}/src/other.ts`) },
	{ role: "assistant", message: assistant(`I opened ${OLD_CWD}/src/main.ts`) },
	{ role: "toolResult", message: toolResult(`wrote ${OLD_CWD}/src/main.ts`, "provider-call-1") },
];

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const blocks = message.content as ReadonlyArray<{ type: string; text?: string }>;
	return blocks
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("a cwd change does not rewrite history already sent", () => {
	it("keeps the bytes of every already-rendered role after the roots change", () => {
		const canonicalizer = createCanonicalizer();
		const history = HISTORY_BY_ROLE.map(entry => entry.message);

		const before = canonicalizer.transform(history, normalizeRoots(OLD_CWD));
		const renderedBefore = before.messages.map(textOf);
		// The optimization has to have done something, or the freeze below is vacuous.
		expect(renderedBefore[0]).toBe("read src/main.ts please");

		const after = canonicalizer.transform([...history, user("now what")], normalizeRoots(NEW_CWD));
		for (let i = 0; i < HISTORY_BY_ROLE.length; i++) {
			expect(textOf(after.messages[i]!)).toBe(renderedBefore[i]!);
		}
	});

	it("reuses the memoized prefix instead of re-rendering it", () => {
		const canonicalizer = createCanonicalizer();
		const history = HISTORY_BY_ROLE.map(entry => entry.message);

		const before = canonicalizer.transform(history, normalizeRoots(OLD_CWD));
		const after = canonicalizer.transform([...history, user("now what")], normalizeRoots(NEW_CWD));

		for (let i = 0; i < HISTORY_BY_ROLE.length; i++) {
			expect(after.messages[i]).toBe(before.messages[i]);
		}
	});

	it("renders a message appended after the change against the new cwd", () => {
		const canonicalizer = createCanonicalizer();
		const history = [user(`read ${OLD_CWD}/src/main.ts`)];

		canonicalizer.transform(history, normalizeRoots(OLD_CWD));
		const after = canonicalizer.transform(
			[...history, user(`now read ${NEW_CWD}/src/main.ts and ${OLD_CWD}/src/main.ts`)],
			normalizeRoots(NEW_CWD),
		);

		// The new cwd is relative; the previous one is a different directory and stays
		// absolute, which is the whole point of a single root.
		expect(textOf(after.messages[1]!)).toBe(`now read src/main.ts and ${OLD_CWD}/src/main.ts`);
	});

	it("never renders two directories as the same string in one message", () => {
		const canonicalizer = createCanonicalizer();
		const listing = toolResult(`${OLD_CWD}\n${NEW_CWD}\n`, "provider-call-1");

		const rendered = textOf(canonicalizer.transform([listing], normalizeRoots(NEW_CWD)).messages[0]!);

		const lines = rendered.split("\n").filter(line => line.length > 0);
		expect(lines).toEqual([OLD_CWD, "."]);
		expect(new Set(lines).size).toBe(lines.length);
	});

	it("accumulates bytes saved across the roots change instead of restarting the count", () => {
		const canonicalizer = createCanonicalizer();
		const history = [user(`read ${OLD_CWD}/src/main.ts`)];

		const before = canonicalizer.transform(history, normalizeRoots(OLD_CWD));
		const after = canonicalizer.transform(
			[...history, user(`read ${NEW_CWD}/src/other.ts`)],
			normalizeRoots(NEW_CWD),
		);

		expect(before.bytesSaved).toBe(OLD_CWD.length + 1);
		expect(after.bytesSaved).toBe(before.bytesSaved + NEW_CWD.length + 1);
	});

	// The unit tests above pin the mechanism on four messages. This replays a
	// growing session the way the request builder drives it — one transform per
	// turn, twelve turns, the working directory moving at turn seven — and measures
	// the byte prefix each request shares with the one before it. That prefix is
	// what a provider's cache is keyed on, so the number is the property itself
	// rather than a proxy for it.
	it("shares its whole previous request as a byte prefix on the turn the directory moves", () => {
		const canonicalizer = createCanonicalizer();
		const history: Message[] = [];
		let previous: string[] = [];
		const rewrittenPerTurn: number[] = [];
		const reuseAtTurn = new Map<number, { reused: number; previousTotal: number }>();
		const moveAtTurn = 7;

		for (let index = 1; index <= 12; index++) {
			const moved = index >= moveAtTurn;
			const cwd = moved ? NEW_CWD : OLD_CWD;
			const sibling = moved ? OLD_CWD : NEW_CWD;
			if (index === moveAtTurn) {
				history.push(setCwdResult(`Moved cwd: ${OLD_CWD} → ${NEW_CWD}`, "provider-call-move"));
			}
			history.push(
				user(`look at ${cwd}/src/module-${index}.ts and ${sibling}/src/module-${index}.ts`),
				assistant(`Reading ${cwd}/src/module-${index}.ts`),
				toolResult(
					`${cwd}/src/module-${index}.ts:1:export const value = ${index};\n${sibling}/src/module-${index}.ts:1:export const value = ${index};`,
					`provider-call-${index}`,
				),
			);

			const rendered = canonicalizer
				.transform([...history], normalizeRoots(cwd))
				.messages.map(message => JSON.stringify(message));
			const shared = rendered.reduce(
				(acc, line, i) =>
					acc.stopped || previous[i] !== line
						? { bytes: acc.bytes, stopped: true }
						: { bytes: acc.bytes + Buffer.byteLength(line, "utf8"), stopped: false },
				{ bytes: 0, stopped: false },
			);
			let rewritten = 0;
			for (let i = 0; i < Math.min(previous.length, rendered.length); i++) {
				if (previous[i] !== rendered[i]) rewritten += 1;
			}
			rewrittenPerTurn.push(rewritten);
			reuseAtTurn.set(index, {
				reused: shared.bytes,
				previousTotal: previous.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8"), 0),
			});
			previous = rendered;
		}

		// Not one message of the twelve turns is ever re-rendered, including the move.
		expect(rewrittenPerTurn).toEqual(Array.from({ length: 12 }, () => 0));

		// The whole of the previous request is still a prefix of the request that
		// follows the move. Before this fix that number was 0 and 18 messages changed.
		const atMove = reuseAtTurn.get(moveAtTurn);
		expect(atMove?.reused).toBe(atMove?.previousTotal);
		expect(atMove?.previousTotal).toBeGreaterThan(0);

		// And every other turn, which is the append-only case the memo already served.
		for (let index = 2; index <= 12; index++) {
			const row = reuseAtTurn.get(index);
			expect(row?.reused).toBe(row?.previousTotal);
		}
	});
});
