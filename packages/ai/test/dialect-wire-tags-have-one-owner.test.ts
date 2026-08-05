/**
 * ONE-PLACE lock for the in-band tag vocabulary the ChatML-family dialects share.
 *
 * Why this suite exists: each of these tags appears in a prompt this repo WRITES and in the model output this
 * repo PARSES, and before `dialect/wire-tags.ts` the two ends were spelled independently. The vocabulary was
 * declared 19 times across 8 modules under 15 names, plus 8 bare literals with no name at all, and no test
 * anywhere compared two spellings of the same tag.
 *
 * That is not a tidiness problem, because every failure mode here is silent. A scanner searching for an opener
 * a renderer no longer writes finds nothing and reports success. A spill repair keyed on a stale closer stops
 * recognising the spill and hands the tool a string with markup in it. A detector that no longer matches the
 * tool-response opener lets the model's invented continuation of the tool output into the visible transcript.
 * In all three the model keeps answering and nothing throws.
 *
 * So the cases below do three things: pin the exact bytes, prove the renderer and the scanner of each dialect
 * agree by ROUND TRIP rather than by both being asserted against the same literal, and ratchet the ownership so
 * a fresh local copy under a new name fails.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type Dialect, getDialectDefinition } from "@veyyon/ai/dialect";
import {
	ARG_KEY_CLOSE,
	ARG_KEY_OPEN,
	ARG_VALUE_CLOSE,
	ARG_VALUE_OPEN,
	CODE_FENCE,
	THINK_CLOSE,
	THINK_OPEN,
	TOOL_CALL_CLOSE,
	TOOL_CALL_OPEN,
	TOOL_RESPONSE_CLOSE,
	TOOL_RESPONSE_OPEN,
	XML_THINKING_CLOSE,
	XML_THINKING_OPEN,
} from "@veyyon/ai/dialect/wire-tags";
import { AI_PROMPTS } from "@veyyon/ai/prompts/registry";
import type { Tool } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { z } from "zod/v4";

const AI_SRC = path.resolve(import.meta.dir, "../src");
const OWNER_REL = "dialect/wire-tags.ts";

/** Every module that used to declare part of this vocabulary, and must now import it. */
const FORMER_DECLARERS: readonly string[] = [
	"dialect/glm.ts",
	"dialect/hermes.ts",
	"dialect/qwen3.ts",
	"dialect/rendering.ts",
	"dialect/thinking.ts",
	"dialect/owned-stream.ts",
	"dialect/demotion.ts",
	"utils/validation.ts",
	"providers/anthropic.ts",
];

/** The names each of those modules used for a tag it no longer owns. */
const RETIRED_NAMES: readonly string[] = [
	"TOOL_OPEN",
	"TOOL_CLOSE",
	"RESPONSE_OPEN",
	"RESPONSE_CLOSE",
	"SPILL_KEY_OPEN",
	"SPILL_KEY_CLOSE",
	"SPILL_VALUE_OPEN",
	"SPILL_VALUE_CLOSE",
	"SPILL_TOOL_CLOSE",
	"THINKING_ENVELOPE_OPEN",
	"THINKING_ENVELOPE_CLOSE",
];

const SHARED_TAGS: ReadonlyArray<readonly [string, string]> = [
	["TOOL_CALL_OPEN", TOOL_CALL_OPEN],
	["TOOL_CALL_CLOSE", TOOL_CALL_CLOSE],
	["TOOL_RESPONSE_OPEN", TOOL_RESPONSE_OPEN],
	["TOOL_RESPONSE_CLOSE", TOOL_RESPONSE_CLOSE],
	["ARG_KEY_OPEN", ARG_KEY_OPEN],
	["ARG_KEY_CLOSE", ARG_KEY_CLOSE],
	["ARG_VALUE_OPEN", ARG_VALUE_OPEN],
	["ARG_VALUE_CLOSE", ARG_VALUE_CLOSE],
	["THINK_OPEN", THINK_OPEN],
	["THINK_CLOSE", THINK_CLOSE],
	["XML_THINKING_OPEN", XML_THINKING_OPEN],
	["XML_THINKING_CLOSE", XML_THINKING_CLOSE],
];

async function aiSources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
	const files = [...new Bun.Glob("**/*.ts").scanSync(AI_SRC)]
		.map(file => file.split(path.sep).join("/"))
		.filter(file => file !== OWNER_REL)
		.sort();
	return await Promise.all(files.map(async file => ({ file, text: await Bun.file(path.join(AI_SRC, file)).text() })));
}

describe("the shared in-band tag bytes", () => {
	/**
	 * The Hermes tool-call envelope, exactly. Pinned as bytes because it is what three dialect prompts tell the
	 * model to emit: a change here without the same change in those prompts means the model is taught one format
	 * and parsed by another, and every tool call becomes visible text.
	 */
	it("names the tool-call envelope", () => {
		expect(TOOL_CALL_OPEN).toBe("<tool_call>");
		expect(TOOL_CALL_CLOSE).toBe("</tool_call>");
	});

	/**
	 * The tool-result envelope, which crosses the widest boundary here: `rendering.ts` writes it and
	 * `owned-stream.ts` searches for it, and the two modules never reference each other.
	 */
	it("names the tool-response envelope", () => {
		expect(TOOL_RESPONSE_OPEN).toBe("<tool_response>");
		expect(TOOL_RESPONSE_CLOSE).toBe("</tool_response>");
	});

	/** GLM's argument tags, shared between the GLM scanner and the spill repair in `utils/validation.ts`. */
	it("names the four GLM argument tags", () => {
		expect(ARG_KEY_OPEN).toBe("<arg_key>");
		expect(ARG_KEY_CLOSE).toBe("</arg_key>");
		expect(ARG_VALUE_OPEN).toBe("<arg_value>");
		expect(ARG_VALUE_CLOSE).toBe("</arg_value>");
	});

	/** Both thinking envelopes, the short ChatML one and the longer XML one. */
	it("names both thinking envelopes", () => {
		expect(THINK_OPEN).toBe("<think>");
		expect(THINK_CLOSE).toBe("</think>");
		expect(XML_THINKING_OPEN).toBe("<thinking>");
		expect(XML_THINKING_CLOSE).toBe("</thinking>");
	});

	/**
	 * Every closer is its opener with a slash after the bracket. This is the one rule the whole family follows,
	 * and it is worth asserting structurally because the scanners match closers with `indexOf`: a closer that
	 * did not correspond to its opener would be a tag the model is never told to write, so the scanner would
	 * hold the rest of the stream waiting for it and emit nothing at all.
	 */
	it("derives every closer from its opener", () => {
		const pairs: ReadonlyArray<readonly [string, string]> = [
			[TOOL_CALL_OPEN, TOOL_CALL_CLOSE],
			[TOOL_RESPONSE_OPEN, TOOL_RESPONSE_CLOSE],
			[ARG_KEY_OPEN, ARG_KEY_CLOSE],
			[ARG_VALUE_OPEN, ARG_VALUE_CLOSE],
			[THINK_OPEN, THINK_CLOSE],
			[XML_THINKING_OPEN, XML_THINKING_CLOSE],
		];
		for (const [open, close] of pairs) {
			expect(close).toBe(`</${open.slice(1)}`);
		}
	});

	/**
	 * The two thinking families are separated by the closing bracket alone, and that is the entire reason a
	 * scanner searching for `<think>` does not fire on `<thinking>`. Asserted because it is the non-obvious
	 * invariant behind keeping two pairs of constants instead of one flag-switched pair: drop the `>` from
	 * either opener and every ChatML scanner starts eating XML-dialect reasoning as its own.
	 */
	it("keeps the short and long thinking openers non-overlapping", () => {
		expect(XML_THINKING_OPEN.startsWith(THINK_OPEN)).toBeFalse();
		expect(XML_THINKING_OPEN.startsWith(THINK_OPEN.slice(0, -1))).toBeTrue();
		expect(THINK_OPEN).not.toBe(XML_THINKING_OPEN);
	});

	/**
	 * No tag carries surrounding whitespace or a newline. They are matched with `indexOf` and `startsWith`
	 * against a token stream, so a tag with a trailing space would fail to match whenever the model formatted
	 * its output differently, which is most of the time.
	 */
	it("holds bare tags with no surrounding whitespace", () => {
		for (const [name, value] of SHARED_TAGS) {
			expect(value, name).toBe(value.trim());
			expect(value, name).not.toContain("\n");
			expect(value.startsWith("<"), name).toBeTrue();
			expect(value.endsWith(">"), name).toBeTrue();
		}
	});

	/** All twelve are distinct, so no two tags can be confused for one another by a scanner. */
	it("holds twelve distinct tags", () => {
		expect(new Set(SHARED_TAGS.map(([, value]) => value)).size).toBe(12);
	});
});

describe("behaviour that depends on the renderer and the scanner agreeing", () => {
	const HERMES_FAMILY: readonly Dialect[] = ["hermes", "qwen3"];

	/**
	 * The real check, and the one that a pair of assertions against the same literal cannot make: render a tool
	 * call with the dialect's own renderer, feed the result to the dialect's own scanner, and require the call
	 * back. This passes only if the two ends use the same bytes, whatever those bytes are.
	 */
	it("round-trips a rendered tool call through each dialect's own scanner", () => {
		for (const dialect of [...HERMES_FAMILY, "glm" as const]) {
			const definition = getDialectDefinition(dialect);
			const rendered = definition.renderToolCall({
				type: "toolCall",
				id: "call-1",
				name: "read_file",
				arguments: { path: "src/main.ts" },
			});
			expect(rendered, dialect).toContain(TOOL_CALL_OPEN);
			expect(rendered, dialect).toContain(TOOL_CALL_CLOSE);

			const scanner = definition.createScanner();
			const events = [...scanner.feed(rendered), ...scanner.flush()];
			const ended = events.flatMap(event => (event.type === "toolEnd" ? [event] : []));
			expect(ended.length, dialect).toBe(1);
			expect(ended[0]?.name, dialect).toBe("read_file");
			expect(ended[0]?.arguments, dialect).toEqual({ path: "src/main.ts" });
		}
	});

	/**
	 * The Hermes family wraps the envelope around a JSON body, so the rendered call is the opener, a JSON
	 * object, and the closer. Asserted with exact structure rather than "contains a tag" so a renderer that
	 * emitted the tags in the wrong order would fail here.
	 */
	it("wraps the JSON body in the envelope for the Hermes family", () => {
		for (const dialect of HERMES_FAMILY) {
			const rendered = getDialectDefinition(dialect).renderToolCall({
				type: "toolCall",
				id: "call-1",
				name: "ls",
				arguments: {},
			});
			expect(rendered, dialect).toBe(`${TOOL_CALL_OPEN}\n{"name":"ls","arguments":{}}\n${TOOL_CALL_CLOSE}`);
		}
	});

	/**
	 * GLM puts `<arg_key>`/`<arg_value>` pairs inside the same envelope, which is why the envelope and the
	 * argument tags are separate constants rather than one bundled record: the envelope is shared with two
	 * dialects that do not use the argument tags at all.
	 */
	it("puts the argument tags inside the shared envelope for GLM", () => {
		const rendered = getDialectDefinition("glm").renderToolCall({
			type: "toolCall",
			id: "call-1",
			name: "read_file",
			arguments: { path: "src/main.ts" },
		});
		expect(rendered).toBe(
			`${TOOL_CALL_OPEN}read_file\n${ARG_KEY_OPEN}path${ARG_KEY_CLOSE}\n` +
				`${ARG_VALUE_OPEN}"src/main.ts"${ARG_VALUE_CLOSE}\n${TOOL_CALL_CLOSE}`,
		);
	});

	/**
	 * The tool-response envelope as the renderer actually writes it, which is the byte sequence
	 * `owned-stream.ts` searches for to find where the host's injected text starts. Checked through the public
	 * `renderToolResults` of each dialect that shares the tag.
	 */
	it("renders tool results in the shared response envelope", () => {
		for (const dialect of ["glm", "hermes", "qwen3", "xml", "pi-native"] satisfies readonly Dialect[]) {
			const rendered = getDialectDefinition(dialect).renderToolResults([
				{ id: "call-1", name: "read_file", index: 0, text: "ok", isError: false },
			]);
			expect(rendered, dialect).toContain(`${TOOL_RESPONSE_OPEN}\nok\n${TOOL_RESPONSE_CLOSE}`);
		}
	});

	/**
	 * The thinking envelope each ChatML dialect renders is the shared one, so the healing scanner in
	 * `thinking.ts` can recognise a leak whichever dialect produced it.
	 */
	it("renders thinking in the shared envelope for every ChatML dialect", () => {
		for (const dialect of ["deepseek", "glm", "hermes", "kimi", "qwen3", "pi-native"] satisfies readonly Dialect[]) {
			const rendered = getDialectDefinition(dialect).renderThinking("weighing options");
			expect(rendered, dialect).toBe(`${THINK_OPEN}\nweighing options\n${THINK_CLOSE}`);
		}
	});

	/**
	 * The spill repair, driven with a payload BUILT from the owner's tags rather than typed out. This is the
	 * consumer that had its own five-name copy, in `utils/` rather than in `dialect/`, and the scenario is real:
	 * the provider parsed the call server-side, the model botched an `</arg_value>` closer, and the remaining
	 * pairs ended up inside the first argument's string.
	 */
	it("repairs a spill written in the owner's tags", () => {
		// `op` is an enum on purpose. The repair is reached only because the polluted string fails validation,
		// so a `z.string()` here would accept the markup and prove nothing.
		const tool: Tool = {
			name: "todo",
			description: "",
			parameters: z.object({ op: z.enum(["done", "view"]), task: z.string().optional() }),
		};
		const spilled = `done${ARG_KEY_CLOSE}\n${ARG_KEY_OPEN}task${ARG_KEY_CLOSE}\n${ARG_VALUE_OPEN}unify the tags`;
		const repaired = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-spill",
			name: "todo",
			arguments: { op: spilled },
		});
		expect(repaired).toEqual({ op: "done", task: "unify the tags" });
	});

	/**
	 * And the trailing-closer variant, which is the one case where the repair needs the TOOL-CALL closer rather
	 * than an argument tag. That closer was the fourth copy of `</tool_call>` in the tree, under a fourth name.
	 */
	it("strips a trailing tool-call closer left in an argument", () => {
		const tool: Tool = { name: "todo", description: "", parameters: z.object({ op: z.enum(["done", "view"]) }) };
		const repaired = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-spill",
			name: "todo",
			arguments: { op: `view${ARG_KEY_CLOSE}\n${TOOL_CALL_CLOSE}` },
		});
		expect(repaired).toEqual({ op: "view" });
	});
});

describe("the prompts teach the same tags the scanners parse", () => {
	/**
	 * A prompt is the one consumer that cannot import a constant: it is prose the model reads. That makes it the
	 * place where drift is most expensive and least visible, because the model would be taught a format nothing
	 * parses and would look simply incapable of calling tools.
	 *
	 * So the coupling is asserted from the constants' side instead. If a tag moves, these fail and name the
	 * prompt that has to move with it.
	 */
	it("teaches the tool-call envelope in all three dialect prompts", () => {
		for (const id of ["dialect/glm", "dialect/hermes", "dialect/qwen3"] as const) {
			const prompt = AI_PROMPTS[id].text;
			expect(prompt, id).toContain(TOOL_CALL_OPEN);
			expect(prompt, id).toContain(TOOL_CALL_CLOSE);
			expect(prompt, id).toContain(TOOL_RESPONSE_OPEN);
		}
	});

	/** GLM's prompt is the only one that teaches the argument tags, because it is the only dialect that uses them. */
	it("teaches the argument tags in the GLM prompt only", () => {
		const glm = AI_PROMPTS["dialect/glm"].text;
		for (const tag of [ARG_KEY_OPEN, ARG_KEY_CLOSE, ARG_VALUE_OPEN, ARG_VALUE_CLOSE]) {
			expect(glm).toContain(tag);
		}
		expect(AI_PROMPTS["dialect/hermes"].text).not.toContain(ARG_KEY_OPEN);
		expect(AI_PROMPTS["dialect/qwen3"].text).not.toContain(ARG_KEY_OPEN);
	});

	/** And the thinking envelope, which the prompts also spell out for the model. */
	it("teaches the shared thinking envelope where a dialect supports it", () => {
		for (const id of ["dialect/glm", "dialect/qwen3", "dialect/kimi", "dialect/pi-native"] as const) {
			expect(AI_PROMPTS[id].text, id).toContain(THINK_OPEN);
		}
	});
});

describe("the markdown code fence", () => {
	/** Three backticks, exactly. */
	it("is three backticks", () => {
		expect(CODE_FENCE).toBe("```");
		expect(CODE_FENCE).toHaveLength(3);
	});

	/**
	 * Two dialects SCAN for it and neither emits it, which is what makes it shared vocabulary rather than a
	 * renderer's detail: DeepSeek closes a tool call's arguments at the LAST fence in the buffer and Gemini
	 * closes a code block at the FIRST one. A copy that drifted would make one of them stop finding the end of a
	 * block and swallow the rest of the stream as arguments.
	 */
	it("is read by both dialects that scan for it", async () => {
		const dialects = path.resolve(import.meta.dir, "../src/dialect");
		for (const file of ["gemini.ts", "deepseek.ts"]) {
			const text = await Bun.file(path.join(dialects, file)).text();
			expect(text, file).toContain("CODE_FENCE");
			expect(text, file).toMatch(/from "\.\/wire-tags";/);
		}
	});

	/**
	 * A fence carrying an INFO STRING stays with its dialect, because the string is that dialect's own
	 * convention rather than shared vocabulary. Both begin with the shared fence, which is the relationship worth
	 * asserting: a change to the fence would have to move them too.
	 */
	it("leaves info-string fences with their dialects", async () => {
		const dialects = path.resolve(import.meta.dir, "../src/dialect");
		const deepseek = await Bun.file(path.join(dialects, "deepseek.ts")).text();
		const gemini = await Bun.file(path.join(dialects, "gemini.ts")).text();
		expect(deepseek).toContain('const LEGACY_JSON_FENCE = "```json";');
		expect(gemini).toContain("const GEMINI_THINK_FENCE_OPEN = ");
		for (const fenced of ["```json", "```thinking\n"]) {
			expect(fenced.startsWith(CODE_FENCE), fenced).toBeTrue();
		}
	});

	/**
	 * And the owner DECLARES only the bare fence, not a dialect's flavour of it. Keyed on the declaration rather
	 * than on the bytes, because the owner's doc names both info-string fences while explaining why they stay
	 * where they are, and that prose is the record of the decision.
	 */
	it("declares only the bare fence", async () => {
		const owner = await Bun.file(path.resolve(import.meta.dir, "../src/dialect/wire-tags.ts")).text();
		expect(owner).toContain('export const CODE_FENCE = "```";');
		// Leading whitespace and spacing around `=` are tolerated. Anchoring hard at the line start is how a
		// sibling lock in `packages/utils/test/url.test.ts` missed a real violation for as long as the
		// formatter kept it wrapped: a source-text check that a reformat defeats reports formatting, not code.
		for (const flavour of ["```json", "```thinking"]) {
			expect(
				new RegExp(`^\\s*(?:export\\s+)?const\\s+\\w+\\s*=\\s*"${flavour}`, "m").test(owner),
				flavour,
			).toBeFalse();
		}
		// And the check is not vacuous: the same pattern DOES match a declaration of that shape.
		expect(/^\s*(?:export\s+)?const\s+\w+\s*=\s*"```json/m.test('\tconst LEGACY_JSON_FENCE = "```json";')).toBeTrue();
	});
});

describe("the vocabulary has one owner", () => {
	/**
	 * The ratchet, keyed on the LITERAL rather than on the retired names. A copy reintroduced under a fresh
	 * spelling is the failure mode a name-based check misses, and it is the likely one: the copies that existed
	 * were all under names of their own.
	 */
	it("declares no shared tag literal outside the owner", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await aiSources()) {
			for (const [, value] of SHARED_TAGS) {
				if (new RegExp(`^\\s*(?:export )?const \\w+ = "${value.replace(/[/]/g, "\\/")}";`, "m").test(text)) {
					offenders.push(`${file} declares ${value}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/** No module uses one of the retired names for a tag either, under any value. */
	it("declares none of the retired tag names", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await aiSources()) {
			for (const name of RETIRED_NAMES) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin. A broken glob would satisfy both ratchets by reading nothing, so require that the
	 * scan reaches every module that used to hold a copy, and that it is reading a whole package rather than a
	 * handful of files.
	 */
	it("scans the whole package including every former declarer", async () => {
		const files = (await aiSources()).map(entry => entry.file);
		expect(files.length).toBeGreaterThan(100);
		for (const declarer of FORMER_DECLARERS) {
			expect(files).toContain(declarer);
		}
	});

	/** The positive half: every former declarer now imports from the owner. */
	it("has every former declarer importing from the owner", async () => {
		for (const declarer of FORMER_DECLARERS) {
			const text = await Bun.file(path.join(AI_SRC, declarer)).text();
			expect(text, declarer).toMatch(/from "(?:\.\.\/dialect\/wire-tags|\.\/wire-tags)";/);
		}
	});

	/**
	 * `gemini.ts` held a `const THINK_OPEN = "```thinking\n"` while six files in the same directory imported a
	 * shared `THINK_OPEN` whose value is `<think>`. One name, one directory, two byte sequences, and adding the
	 * shared name to gemini's import list would have silently shadowed it. Renamed for its dialect, and locked
	 * so no module can take the bare name back.
	 */
	it("leaves no module declaring a bare THINK_OPEN or THINK_CLOSE", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await aiSources()) {
			for (const name of ["THINK_OPEN", "THINK_CLOSE", "XML_THINKING_OPEN", "XML_THINKING_CLOSE"]) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
		const gemini = await Bun.file(path.join(AI_SRC, "dialect/gemini.ts")).text();
		expect(gemini).toContain('const GEMINI_THINK_FENCE_OPEN = "```thinking\\n";');
	});

	/**
	 * The owner is a leaf. That is the whole reason the copies existed: `utils/validation.ts` is not a dialect
	 * and reaching `dialect/rendering.ts` for a tag would have pulled the coercion helpers and the dialect types
	 * behind a string, so retyping five tags was the cheaper choice. An import here brings that back.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.join(AI_SRC, OWNER_REL)).text();
		// The PARSED specifier list, not the characters: the scan this replaced also went red on a doc
		// comment containing `from "..."`, and on a free `import type`, which costs nothing at runtime.
		expect(moduleSpecifiersIn(owner)).toEqual([]);
	});

	/**
	 * The general form of the worst case, asserted as a scan rather than as a list of the three names that were
	 * wrong. Three sibling dialects used one name for different bytes: `THINK_OPEN` was `<think>` in six files
	 * and ` ```thinking\n ` in `gemini.ts`, `CALL_OPEN` was `<|tool_call>` in `gemma.ts` and `<call:` in
	 * `pi-native.ts`, and `RESPONSE_OPEN` was `<|tool_response>` in `gemma.ts` and `<tool_response>` in
	 * `glm.ts`. Each is a latent bug rather than a style nit: a reader who learns the name in one file carries
	 * the wrong bytes into the next, and in the `THINK_OPEN` case adding the shared name to gemini's imports
	 * would have shadowed it silently.
	 *
	 * The scan is over declared string tags in the dialect directory, so a future dialect reusing any of these
	 * names for its own token fails here rather than in a reader's head.
	 */
	it("gives no tag name two different values across the dialect directory", async () => {
		const byName = new Map<string, Map<string, string[]>>();
		for (const { file, text } of await aiSources()) {
			if (!file.startsWith("dialect/")) continue;
			for (const match of text.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = ("(?:[^"\\]|\\.)*");$/gm)) {
				const name = match[1] as string;
				const value = match[2] as string;
				const values = byName.get(name) ?? new Map<string, string[]>();
				values.set(value, [...(values.get(value) ?? []), file]);
				byName.set(name, values);
			}
		}
		const divergent = [...byName]
			.filter(([, values]) => values.size > 1)
			.map(
				([name, values]) =>
					`${name}: ${[...values].map(([value, files]) => `${value} in ${files.join(",")}`).join(" vs ")}`,
			);
		expect(divergent).toEqual([]);
		// Non-vacuity: the scan really did read the dialect tag declarations it claims to check.
		expect(byName.get("GEMMA_CALL_OPEN")?.has('"<|tool_call>"')).toBeTrue();
		expect(byName.get("PI_CALL_OPEN")?.has('"<call:"')).toBeTrue();
		expect(byName.size).toBeGreaterThan(20);
	});

	/**
	 * The deliberate exemption, recorded so the boundary is readable rather than a matter of taste: a tag used
	 * by one dialect and nobody else stays with that dialect. Hoisting DeepSeek's fullwidth tokens, Harmony's
	 * channel markers or Gemma's turn envelope would turn the owner into a dumping ground in which a reader
	 * could no longer tell which tags are actually shared, which is the property that makes it useful.
	 */
	it("leaves single-dialect tags with their dialect", async () => {
		const owner = await Bun.file(path.join(AI_SRC, OWNER_REL)).text();
		for (const single of ["<｜begin▁of▁sentence｜>", "<|channel|>", "<|tool_call>", "```tool_code"]) {
			expect(owner).not.toContain(single);
		}
		const deepseek = await Bun.file(path.join(AI_SRC, "dialect/deepseek.ts")).text();
		expect(deepseek).toContain('const DEEPSEEK_BOS = "<｜begin▁of▁sentence｜>";');
		const harmony = await Bun.file(path.join(AI_SRC, "dialect/harmony.ts")).text();
		expect(harmony).toContain('const CHANNEL = "<|channel|>";');
	});
});
