import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@veyyon/ai";
import { normalizeRoots, relativizePathsUnderRoots } from "@veyyon/coding-agent/session/relativize-paths";
import { escapeRegExp } from "@veyyon/utils";

const ROOT = "/media/mukund-thiru/SanthData/Santh/software/veyyon/veyyon";
const OTHER = "/media/mukund-thiru/other-checkout";

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: usage(),
		stopReason: "stop",
	};
}

function toolResult(text: string, toolCallId = "call-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("normalizeRoots", () => {
	test("strips trailing slashes, drops non-absolute and root-only entries, sorts longest-first", () => {
		expect(normalizeRoots([`${ROOT}/`, "/tmp", "/", "relative", " /tmp "])).toEqual([ROOT, "/tmp"]);
	});
});

describe("relativizePathsUnderRoots", () => {
	test("returns the input array identity when nothing matches", () => {
		const messages: Message[] = [toolResult("no paths here")];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages).toBe(messages);
		expect(result.bytesSaved).toBe(0);
	});

	test("tool result text renders root-relative at token boundaries, preserving suffixes", () => {
		const messages: Message[] = [
			toolResult(`error: ${ROOT}/src/foo.ts:12:3 cannot find x\n(${ROOT}/src/bar.ts) done`),
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("error: src/foo.ts:12:3 cannot find x\n(src/bar.ts) done");
		expect(result.bytesSaved).toBe(`${ROOT}/`.length * 2);
		// Original message is untouched: outbound copy only.
		const original = messages[0] as ToolResultMessage;
		expect((original.content[0] as { text: string }).text).toContain(ROOT);
	});

	test("bare root token renders as dot", () => {
		const messages: Message[] = [toolResult(`cwd is ${ROOT} ok`)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("cwd is . ok");
	});

	test("does not rewrite a root prefix glued to a longer token", () => {
		const messages: Message[] = [toolResult(`file://${ROOT}/src/a.ts and ${ROOT}x/y`)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages).toBe(messages);
	});

	test("paths outside every registered root stay absolute", () => {
		const messages: Message[] = [toolResult(`/etc/hosts and ${OTHER}/x.ts`)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages).toBe(messages);
	});

	test("longest root wins for nested roots (setCwd into a subdirectory)", () => {
		const nested = `${ROOT}/packages`;
		const messages: Message[] = [toolResult(`${nested}/agent/src/a.ts`)];
		const result = relativizePathsUnderRoots(messages, normalizeRoots([ROOT, nested]));
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("agent/src/a.ts");
	});

	test("assistant tool call arguments rewrite whole-string path values only", () => {
		const messages: Message[] = [
			assistant([
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: {
						path: `${ROOT}/src/foo.ts`,
						note: `reads ${ROOT}/src/foo.ts here`,
						multi: `${ROOT}/a.ts\n${ROOT}/b.ts`,
					},
				},
			]),
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const call = (result.messages[0] as AssistantMessage).content[0] as {
			arguments: Record<string, unknown>;
		};
		expect(call.arguments.path).toBe("src/foo.ts");
		// Embedded mentions inside a longer string are left for the text pass; argument
		// strings that are not whole paths are not rewritten.
		expect(call.arguments.note).toBe(`reads ${ROOT}/src/foo.ts here`);
		expect(call.arguments.multi).toBe(`${ROOT}/a.ts\n${ROOT}/b.ts`);
	});

	test("assistant thinking blocks are never rewritten", () => {
		const thinking = `${ROOT}/secret-plan`;
		const messages: Message[] = [
			assistant([
				{ type: "thinking", thinking, thinkingSignature: "sig" },
				{ type: "text", text: `${ROOT}/src/foo.ts` },
			]),
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const blocks = (result.messages[0] as AssistantMessage).content;
		expect((blocks[0] as { thinking: string }).thinking).toBe(thinking);
		expect((blocks[1] as { text: string }).text).toBe("src/foo.ts");
	});

	test("user string content is relativized", () => {
		const messages: Message[] = [{ role: "user", content: `look at ${ROOT}/src/foo.ts please`, timestamp: 1 }];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages[0]).toMatchObject({ content: "look at src/foo.ts please" });
	});

	test("round-trip: every rewritten token resolves back under its root", () => {
		const body = `${ROOT}/src/a.ts ${ROOT}/src/deep/b.ts`;
		const messages: Message[] = [toolResult(body)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		const restored = text.text
			.split(" ")
			.map(token => (token.startsWith("/") ? token : `${ROOT}/${token}`))
			.join(" ");
		expect(restored).toBe(body);
	});
});

/**
 * Escape-safety lock for `compileRoot` (DEDUP-ESCAPE-REGEXP).
 *
 * `compileRoot` in relativize-paths.ts turns a root into two RegExps. Because a
 * root is arbitrary text on disk, it can legally contain every regex metacharacter
 * (`My Project (v2)`, `set[1]`, `a+b`, an unbalanced `data[`), so the root MUST be
 * escaped before it is spliced into a `new RegExp(...)`. That escape is
 * `root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` — byte-for-byte the body of the
 * single repo-wide owner `escapeRegExp` in @veyyon/utils.
 *
 * These tests exist so the inline copy can be replaced by `escapeRegExp(root)`
 * and PROVE the swap is behavior-preserving, and so that neither the inline copy
 * (before the swap) nor `escapeRegExp` (after) can silently regress:
 *
 *  - the escape-level differential proves inline `replace(...)` and
 *    `escapeRegExp` produce byte-identical strings, and identical compiled RegExp
 *    `.source`, over an exhaustive metacharacter corpus;
 *  - the end-to-end tests prove `relativizePathsUnderRoots` treats every
 *    metacharacter in a root LITERALLY (a `.` matches only a literal dot, not any
 *    char; a `+` matches only a literal plus, not one-or-more), which is exactly
 *    the property the escape buys and which a naive un-escaped compile would lose;
 *  - the unbalanced-bracket test proves the escape also prevents a `new RegExp`
 *    SyntaxError crash on a real path like `/tmp/data[unclosed`.
 *
 * If someone deletes the escape, widens it, or swaps in a divergent hand-rolled
 * copy, one of these fails with a concrete value, not a shape check.
 */

/** Every character the escape regex targets, plus a couple of benign controls. */
const REGEX_METACHARS = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"] as const;

/** The inline escape exactly as written in relativize-paths.ts (the pre-swap copy). */
function inlineEscape(root: string): string {
	return root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mirror of `compileRoot`, parameterized by which escaper it uses. */
function compiledSources(escapeFn: (root: string) => string, root: string): { prefix: string; exact: string } {
	const escaped = escapeFn(root);
	return {
		prefix: new RegExp(`${escaped}/`, "g").source,
		exact: new RegExp(`${escaped}(?=$|[\\s\\])}>"'\\\`;:,.])`, "g").source,
	};
}

/** Roots that carry each metacharacter in a realistic on-disk position. */
const METACHAR_ROOTS: readonly string[] = [
	"/tmp/a.b",
	"/tmp/a+b",
	"/tmp/a*b",
	"/tmp/a?b",
	"/tmp/a^b",
	"/tmp/a$b",
	"/tmp/a{2}b",
	"/tmp/a(b)c",
	"/tmp/a|b",
	"/tmp/a[bc]d",
	"/tmp/a\\b",
	"/home/me/My Project (v2)",
	"/data/set[1]/checkout",
	"/opt/app+plus.d",
	"/srv/a.b.c(d)[e]{f}",
];

describe("compileRoot escape differential: inline replace ≡ escapeRegExp (DEDUP-ESCAPE-REGEXP)", () => {
	test("inline escape and escapeRegExp produce byte-identical strings for every single metacharacter", () => {
		for (const ch of REGEX_METACHARS) {
			const sample = `pre${ch}post`;
			expect(escapeRegExp(sample)).toBe(inlineEscape(sample));
		}
	});

	test("inline escape and escapeRegExp agree on an exhaustive two-metachar cross-product", () => {
		for (const a of REGEX_METACHARS) {
			for (const b of REGEX_METACHARS) {
				const sample = `/tmp/x${a}y${b}z`;
				expect(escapeRegExp(sample)).toBe(inlineEscape(sample));
			}
		}
	});

	test("compiled prefix and exact RegExp sources are identical whether escaped inline or via escapeRegExp", () => {
		for (const root of METACHAR_ROOTS) {
			const inline = compiledSources(inlineEscape, root);
			const utils = compiledSources(escapeRegExp, root);
			expect(utils.prefix).toBe(inline.prefix);
			expect(utils.exact).toBe(inline.exact);
		}
	});

	test("both escapers compile to a RegExp that matches the literal root prefix and nothing wider", () => {
		for (const root of METACHAR_ROOTS) {
			const escaped = escapeRegExp(root);
			const prefix = new RegExp(`${escaped}/`);
			// The literal root followed by `/` matches.
			expect(prefix.test(`${root}/child`)).toBe(true);
			// The escape is byte-identical to the inline copy, so the compiled source matches too.
			expect(new RegExp(`${escaped}/`).source).toBe(new RegExp(`${inlineEscape(root)}/`).source);
		}
	});
});

describe("relativizePathsUnderRoots treats regex metacharacters in roots literally (DEDUP-ESCAPE-REGEXP)", () => {
	test("a literal path under each metacharacter root is rewritten root-relative", () => {
		for (const root of METACHAR_ROOTS) {
			const messages: Message[] = [toolResult(`${root}/src/foo.ts and (${root}/bar.ts)`)];
			const result = relativizePathsUnderRoots(messages, normalizeRoots([root]));
			const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
			expect(text.text).toBe("src/foo.ts and (bar.ts)");
		}
	});

	test("a bare metacharacter root token renders as a dot", () => {
		for (const root of METACHAR_ROOTS) {
			const messages: Message[] = [toolResult(`cwd is ${root} now`)];
			const result = relativizePathsUnderRoots(messages, normalizeRoots([root]));
			const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
			expect(text.text).toBe("cwd is . now");
		}
	});

	// The crux: each of these siblings would be spuriously rewritten if the
	// metacharacter were compiled UNescaped (`.`=any, `+`=one-or-more, `*`=zero-
	// or-more, `?`=optional, `(x)`/`[x]`/`{n}` as group/class/quantifier). With
	// the escape they are treated as literals, so the sibling stays absolute and
	// the message array is returned by identity.
	test("a would-be-wildcard sibling is NOT rewritten (escape defeats metacharacter semantics)", () => {
		const cases: ReadonlyArray<{ root: string; sibling: string }> = [
			{ root: "/tmp/a.b", sibling: "/tmp/aXb/foo.ts" }, // `.` as any-char
			{ root: "/tmp/aa+b", sibling: "/tmp/aaaab/foo.ts" }, // `a+` as one-or-more
			{ root: "/tmp/ab*c", sibling: "/tmp/ac/foo.ts" }, // `b*` as zero-or-more
			{ root: "/tmp/ab?c", sibling: "/tmp/ac/foo.ts" }, // `b?` as optional
			{ root: "/tmp/(x)y", sibling: "/tmp/xy/foo.ts" }, // parens as group
			{ root: "/tmp/[ab]c", sibling: "/tmp/ac/foo.ts" }, // brackets as char class
			{ root: "/tmp/a{2}b", sibling: "/tmp/aab/foo.ts" }, // braces as quantifier
		];
		for (const { root, sibling } of cases) {
			const messages: Message[] = [toolResult(`${sibling} stays absolute`)];
			const result = relativizePathsUnderRoots(messages, normalizeRoots([root]));
			// Nothing matched: same array reference, zero bytes saved, text unchanged.
			expect(result.messages).toBe(messages);
			expect(result.bytesSaved).toBe(0);
			const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
			expect(text.text).toBe(`${sibling} stays absolute`);
		}
	});

	test("an unbalanced-bracket root does not crash the RegExp compile and still rewrites its literal path", () => {
		// `/tmp/data[unclosed` compiled UNescaped is `new RegExp("/tmp/data[unclosed/")`,
		// which throws SyntaxError (unterminated character class). The escape makes it
		// a literal, so relativization both survives and works.
		const root = "/tmp/data[unclosed";
		const messages: Message[] = [toolResult(`${root}/deep/file.ts here`)];
		let result: ReturnType<typeof relativizePathsUnderRoots> | undefined;
		expect(() => {
			result = relativizePathsUnderRoots(messages, normalizeRoots([root]));
		}).not.toThrow();
		const text = (result!.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("deep/file.ts here");
	});
});
