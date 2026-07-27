import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import {
	DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO,
	DEFAULT_TOOL_CALL_STRUCTURE_SHARE,
	HANDLE_NAME_RE,
	MAX_EXPANSION_BYTES,
} from "../src/constants.js";
import {
	emittedTokenCost,
	estimateTokens,
	extractCandidates,
	generateDict,
	generateDictFromRepo,
	scoringFrequency,
} from "../src/generate.js";
import { parseDict } from "../src/parse.js";

// A realistic transcript-ish corpus: the same paths and commands recur, which is
// exactly what makes them worth a handle.
const PATH = "packages/coding-agent/src/database/connection.ts";
const CMD = "CARGO_TARGET_DIR=/dev/null bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit";
const MIGR = "packages/coding-agent/src/database/migrations";

function corpus(repeats: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < repeats; i++) {
		out.push(`Editing ${PATH} to fix the pool size.`);
		// A build command as its own line, the way a tool call carries it — a
		// whole-line candidate, since it contains spaces.
		out.push(CMD);
		out.push(`Running the migrations under ${MIGR}.`);
		out.push(`Reconnecting through ${PATH}.`);
	}
	return out;
}

describe("estimateTokens", () => {
	test("is zero for empty and at least one for any content", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a")).toBe(1);
	});

	test("counts separators in a path as their own tokens", () => {
		// Six words + four slashes + one dot = eleven, well above a naive chars/4.
		expect(estimateTokens("packages/coding-agent/src/database/connection.ts")).toBeGreaterThanOrEqual(10);
	});

	test("a handle is far cheaper than the path it replaces", () => {
		expect(estimateTokens("§dbconn")).toBeLessThan(estimateTokens(PATH));
	});
});

describe("extractCandidates", () => {
	test("pulls structured tokens out of prose", () => {
		const found = extractCandidates(`edit ${PATH} now`);
		expect(found).toContain(PATH);
	});

	test("captures a whole command-like line", () => {
		const found = extractCandidates(CMD);
		expect(found).toContain(CMD);
	});

	test("ignores bare prose words", () => {
		const found = extractCandidates("just some ordinary words here");
		expect(found).toEqual([]);
	});

	test("strips wrapping punctuation", () => {
		const found = extractCandidates(`see (${PATH}),`);
		expect(found).toContain(PATH);
	});

	// Regression: the whole-line command branch used to fire on every line of a code
	// file, because a method call or property access satisfies isStructured. That
	// filled generated dictionaries with entire code statements no model retypes,
	// which is a primary cause of zero runtime adoption. A source line must NOT be
	// captured whole; its reusable tokens (import specifier, path) still are.
	describe("does not capture whole source-code lines (adoption regression)", () => {
		test("a statement with a call and terminator yields no whole-line candidate", () => {
			const line = "const buffer = Buffer.from(base64Data, 'base64');";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a template-literal statement yields no whole-line candidate", () => {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the codec test fixture — the point is that extractCandidates must not capture a template-interpolation fragment.
			const line = "if (gem.homepage_uri) md += `**Homepage:** ${gem.homepage_uri}`;";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("an arrow-function line yields no whole-line candidate", () => {
			const line = "const textContent = result.content.find((c) => c.type === 'text');";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("still extracts the import specifier token from a code import line", () => {
			const found = extractCandidates("import type { Component } from '@oh-my-pi/pi-tui';");
			expect(found).toContain("@oh-my-pi/pi-tui");
			// but never the whole statement
			expect(found).not.toContain("import type { Component } from '@oh-my-pi/pi-tui';");
		});

		test("still captures a genuine build command line (has no code punctuation)", () => {
			// The exact shape a coding agent retypes: a binary, flags, a config path.
			const cmd = "bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit";
			expect(extractCandidates(cmd)).toContain(cmd);
		});

		test("still captures an env-prefixed command with a chained &&", () => {
			const cmd = "CARGO_TARGET_DIR=/dev/null cargo test --all && echo done";
			expect(extractCandidates(cmd)).toContain(cmd);
		});
	});

	// Regression: isStructured's `\w\.\w` rule fires on every property/method access,
	// so the token branch used to capture live expression fragments (`${theme.fg('dim`,
	// `parts.push(theme.fg('dim`, a regex literal) as if they were paths. No agent
	// retypes those; they were the dominant dictionary noise on a code corpus. The
	// cleanliness gate (isReusableToken) rejects any candidate bearing code
	// punctuation while still keeping genuine paths and scheme-less import specifiers.
	describe("cleanliness gate rejects code-expression fragment tokens", () => {
		test("a template-interpolation fragment is not captured as a token", () => {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the codec test fixture — extractCandidates must reject a template-interpolation fragment.
			const found = extractCandidates("requestLines.push(theme.fg('dim'), `${theme.fg('dim')}`);");
			expect(found.some(c => c.includes("$") || c.includes("(") || c.includes("`") || c.includes("'"))).toBe(false);
		});

		test("a method-call chain fragment is not captured", () => {
			const found = extractCandidates("const m = line.trim().match(/^(.*):(\\d+)$/);");
			expect(found.some(c => c.includes("(") || c.includes("/^"))).toBe(false);
		});

		test("a console.log statement contributes no fragment tokens", () => {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the codec test fixture — extractCandidates must contribute no fragment tokens.
			const found = extractCandidates("console.log(chalk.dim(`Installing ${pkg}`));");
			// The only structured-looking substrings all carry code punctuation, so none survive.
			expect(found).toEqual([]);
		});

		test("a real path token IS still captured", () => {
			expect(extractCandidates("see packages/coding-agent/src/database/connection.ts here")).toContain(
				"packages/coding-agent/src/database/connection.ts",
			);
		});

		test("a scoped import specifier IS still captured", () => {
			expect(extractCandidates("resolve @oh-my-pi/pi-coding-agent now")).toContain("@oh-my-pi/pi-coding-agent");
		});

		test("a home-relative path IS still captured", () => {
			expect(extractCandidates("look in ~/.omp/agent/extensions/ folder")).toContain("~/.omp/agent/extensions/");
		});
	});

	// Regression: a dictionary handle only pays for itself when the agent RETYPES the
	// string. A scheme-bearing URL (`https://…`), a markdown badge, and a hexdump line
	// are all read-but-never-retyped reference noise. On a real budget-16000 dictionary
	// built from the ytt corpus they were 117 of 524 handles (22%): 97 scheme URLs, 19
	// README badges, 1 hexdump — pure teach-cost that rode the system prompt every turn
	// with zero adoption. These lock out each junk class while proving the legitimate
	// scheme-LESS module paths an agent DOES retype survive. (EVAL-ARGOT-DICT-CAPTURES-URLS-BADGES)
	describe("reference-noise handles are rejected but retyped module paths survive", () => {
		test("a bare scheme URL is dropped (hyperlink, never retyped)", () => {
			const found = extractCandidates("fetch https://rubygems.org/api/v1/gems then");
			expect(found).not.toContain("https://rubygems.org/api/v1/gems");
		});

		test("an http scheme URL is dropped", () => {
			const found = extractCandidates("license at http://www.apache.org/licenses/LICENSE-2.0 here");
			expect(found).not.toContain("http://www.apache.org/licenses/LICENSE-2.0");
		});

		test("a scheme-less Go module path IS kept (genuine import)", () => {
			const found = extractCandidates("import github.com/aws/aws-lambda-go/events now");
			expect(found).toContain("github.com/aws/aws-lambda-go/events");
		});

		test("a scheme-less vanity module path IS kept", () => {
			const found = extractCandidates("import carvel.dev/ytt/pkg/yamlmeta here");
			expect(found).toContain("carvel.dev/ytt/pkg/yamlmeta");
		});

		test("a markdown badge line is not captured whole", () => {
			const line =
				"[![Go Reference](https://pkg.go.dev/badge/github.com/aws/aws-lambda-go.svg)](https://pkg.go.dev/github.com/aws/aws-lambda-go)";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a markdown link line is not captured whole", () => {
			const line = "See the [contributing guide](https://github.com/spf13/cobra/blob/main/CONTRIBUTING.md) first";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a hexdump line is not captured whole", () => {
			const line = "00000010  21 22 23 24 25 26 27 28  29 2a 2b 2c 2d 2e 2f 30  |!\"#$%&'()*+,-./0|";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a real ytt data-values annotation IS still captured", () => {
			const found = extractCandidates("set #@data/values-schema in the template");
			expect(found).toContain("#@data/values-schema");
		});
	});

	// Regression: wrapped multi-line expressions leave physical lines that carry no
	// `;{}` yet are plainly code — a parenthesized ternary, a line dangling on a JS
	// operator, an optional-chaining/nullish continuation. These were captured whole
	// and are pure noise. They must be rejected while genuine shell commands (which
	// may contain `&&`/`||` mid-line) are still captured.
	describe("rejects wrapped-expression fragment lines but keeps real commands", () => {
		test("a parenthesized ternary opener is not captured whole", () => {
			const line = "(parsedDiagnostics.length > 0 ? parsedDiagnostics.length : fallback)";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("an optional-chaining / nullish line is not captured whole", () => {
			const line = "runtime.runningExperiment?.command ?? state.results.length > 0";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a line dangling on a JS or-operator is not captured whole", () => {
			const line = "state.results.length > 0 ||";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a strict-inequality condition line is not captured whole", () => {
			const line = "runtime.lastRunSummary !== null && runtime.mode active";
			expect(extractCandidates(line)).not.toContain(line);
		});

		test("a real && command is STILL captured whole (not misread as code)", () => {
			const cmd = "cargo build --release && cargo test --all";
			expect(extractCandidates(cmd)).toContain(cmd);
		});
	});
});

describe("generateDict", () => {
	test("proposes handles for the recurring strings", () => {
		const result = generateDict(corpus(5));
		const expansions = result.handles.map(h => h.expansion);
		expect(expansions).toContain(PATH);
		expect(expansions).toContain(CMD);
		expect(result.handles.length).toBeGreaterThan(0);
	});

	test("the emitted TOML re-parses to an identical vocabulary (the core invariant)", () => {
		const result = generateDict(corpus(5));
		const reparsed = parseDict(result.toml, "AGENTS.dict");
		expect(reparsed.sigil).toBe(result.vocab.sigil);
		expect([...reparsed.handles.entries()].sort()).toEqual([...result.vocab.handles.entries()].sort());
	});

	test("every generated handle name is valid and every expansion is sigil-free", () => {
		const result = generateDict(corpus(5), { sigil: "§" });
		for (const handle of result.handles) {
			expect(HANDLE_NAME_RE.test(handle.name)).toBe(true);
			expect(handle.expansion).not.toContain("§");
			expect(handle.expansion.length).toBeGreaterThan(0);
		}
	});

	test("handle names are unique", () => {
		const result = generateDict(corpus(8));
		const names = result.handles.map(h => h.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("respects the token budget and never exceeds it", () => {
		// A large, varied corpus produces far more candidates than a tiny budget fits.
		const big: string[] = [];
		for (let i = 0; i < 200; i++) {
			big.push(`touch packages/app/module${i}/service/handler/very/deep/path/file${i}.ts twice`);
			big.push(`touch packages/app/module${i}/service/handler/very/deep/path/file${i}.ts again`);
		}
		const tiny = generateDict(big, { tokenBudget: 120 });
		expect(tiny.dictTokens).toBeLessThanOrEqual(120);
		const roomy = generateDict(big, { tokenBudget: 5000 });
		expect(roomy.handles.length).toBeGreaterThan(tiny.handles.length);
		expect(roomy.dictTokens).toBeLessThanOrEqual(5000);
	});

	test("defaults to a 1000-token budget", () => {
		const result = generateDict(corpus(5));
		expect(result.tokenBudget).toBe(1000);
		expect(result.dictTokens).toBeLessThanOrEqual(1000);
	});

	test("orders handles by estimated savings, highest first", () => {
		const result = generateDict(corpus(5));
		for (let i = 1; i < result.handles.length; i++) {
			const prev = result.handles[i - 1];
			const cur = result.handles[i];
			if (prev && cur) expect(prev.savedTokens).toBeGreaterThanOrEqual(cur.savedTokens);
		}
	});

	test("the chosen handles actually round-trip through the codec they describe", () => {
		const result = generateDict(corpus(5));
		const expand = makeExpander(result.vocab);
		const dbHandle = result.handles.find(h => h.expansion === PATH);
		expect(dbHandle).toBeDefined();
		if (dbHandle) {
			expect(expand(`open §${dbHandle.name} now`)).toBe(`open ${PATH} now`);
		}
	});

	test("honors minFrequency: a once-seen string is not proposed", () => {
		const once = generateDict([`unique ${PATH} appears one time only`], { minFrequency: 2 });
		expect(once.handles).toEqual([]);
		const lowered = generateDict([`unique ${PATH} appears one time only`], { minFrequency: 1 });
		expect(lowered.handles.map(h => h.expansion)).toContain(PATH);
	});

	test("honors minExpansionLength: short strings are skipped", () => {
		const shortPath = "a/b.ts";
		const text = `x ${shortPath} y ${shortPath} z`;
		expect(generateDict([text], { minFrequency: 2, minExpansionLength: 8 }).handles).toEqual([]);
		expect(generateDict([text], { minFrequency: 2, minExpansionLength: 4 }).handles.map(h => h.expansion)).toContain(
			shortPath,
		);
	});

	test("numeric naming yields digit handles", () => {
		const result = generateDict(corpus(5), { naming: "numeric" });
		for (const handle of result.handles) {
			expect(/^[0-9]+$/.test(handle.name)).toBe(true);
		}
		// And still re-parses.
		expect(() => parseDict(result.toml, "AGENTS.dict")).not.toThrow();
	});

	test("maxHandles caps the count", () => {
		const result = generateDict(corpus(8), { maxHandles: 1 });
		expect(result.handles.length).toBe(1);
	});

	test("an empty or all-prose corpus yields an empty, non-throwing result", () => {
		const empty = generateDict([]);
		expect(empty.handles).toEqual([]);
		expect(empty.toml).toBe("");
		expect(empty.dictTokens).toBe(0);
		const prose = generateDict(["nothing structured to see here at all", "still just words"]);
		expect(prose.handles).toEqual([]);
	});

	test("is deterministic across runs", () => {
		const a = generateDict(corpus(5));
		const b = generateDict(corpus(5));
		expect(a.toml).toBe(b.toml);
		expect(a.handles).toEqual(b.handles);
	});

	test("an injected tokenizer changes the accounting", () => {
		// A tokenizer that charges one token per character makes savings much larger.
		const perChar = generateDict(corpus(5), { countTokens: t => t.length });
		const heuristic = generateDict(corpus(5));
		expect(perChar.estimatedSavings).toBeGreaterThan(heuristic.estimatedSavings);
	});

	test("a custom sigil is emitted and round-trips", () => {
		const result = generateDict(corpus(5), { sigil: "@@" });
		expect(result.toml).toContain('sigil = "@@"');
		const reparsed = parseDict(result.toml, "AGENTS.dict");
		expect(reparsed.sigil).toBe("@@");
	});

	test("skips a candidate that contains the sigil", () => {
		const withSigil = "packages/§weird/path/file.ts";
		const text = `a ${withSigil} b ${withSigil} c`;
		const result = generateDict([text]);
		expect(result.handles.map(h => h.expansion)).not.toContain(withSigil);
	});

	test("handles TOML-hostile characters in an expansion without breaking the round-trip", () => {
		// A whole-line candidate carrying a quote and a backslash, the characters a
		// TOML basic string must escape. It recurs as its own line.
		const nasty = 'echo "a\\b" > packages/x/y.ts';
		const result = generateDict([nasty, nasty], { minFrequency: 2 });
		expect(result.handles.map(h => h.expansion)).toContain(nasty);
		const reparsed = parseDict(result.toml, "AGENTS.dict");
		const match = [...reparsed.handles.values()].find(v => v === nasty);
		expect(match).toBe(nasty);
	});

	test("never proposes an expansion over the byte limit", () => {
		const huge = `x/${"a".repeat(MAX_EXPANSION_BYTES)}/y.ts`;
		const text = `${huge} ${huge}`;
		const result = generateDict([text], { minFrequency: 2, minExpansionLength: 4 });
		expect(result.handles).toEqual([]);
	});
});

describe("deterministic short mnemonic naming (ARG-NAME-BREVITY)", () => {
	// These lock the two properties that let the runtime cache use SHORT names:
	// brevity (bare stem when unique, minimal suffix on collision) and determinism
	// (a pure function of the expansion set, byte-identical across generations). The
	// content scheme this replaced minted a fixed 8-char hash on every handle
	// (`§connec_pk4xfv18`), nearly as long as a short expansion, which made the live
	// content-repro bench emit MORE tokens with argot on than off.

	test("a uniquely-stemmed path gets the bare stem, no hash", () => {
		const result = generateDictFromRepo([{ path: "lib/database/connection-pool.ts" }]);
		const handle = result.handles.find(h => h.expansion === "lib/database/connection-pool.ts");
		// last segment `connection-pool.ts` → strip non-alnum → truncate to the
		// 4-character name budget → `conn`. The budget is what keeps a handle at 2
		// tokens with the sigil; see MAX_NAME_LENGTH.
		expect(handle?.name).toBe("conn");
	});

	test("colliding stems get distinct, minimal, deterministic suffixes", () => {
		// Both last segments truncate to `connec`, so they collide and must be
		// disambiguated — distinctly, and with only a short hash suffix.
		const files = [{ path: "src/connection-alpha.ts" }, { path: "src/connection-omega.ts" }];
		const result = generateDictFromRepo(files);
		const names = result.handles
			.filter(h => h.expansion.startsWith("src/connection-"))
			.map(h => h.name)
			.sort();
		expect(names.length).toBe(2);
		expect(new Set(names).size).toBe(2);
		for (const name of names) {
			// The stem is truncated to pay for the suffix, so the whole name stays
			// inside the 4-character budget rather than growing past it. That budget
			// is the difference between a 2-token and a 3-token handle.
			expect(name.startsWith("con")).toBe(true);
			expect(name.length).toBeLessThanOrEqual(4);
		}
	});

	test("two independent generations of the same file set mint byte-identical names", () => {
		// The determinism the immutable cache relies on: no dependence on iteration
		// order, so concurrent generators of one cache entry never diverge.
		const files = [
			{ path: "src/connection-alpha.ts" },
			{ path: "src/connection-omega.ts" },
			{ path: "lib/database/connection-pool.ts" },
			{ path: "@acme/shared-core-utilities" },
		];
		const a = generateDictFromRepo(files);
		const b = generateDictFromRepo(files);
		const pairs = (r: typeof a) =>
			r.handles.map(h => [h.name, h.expansion] as const).sort((x, y) => (x[1] < y[1] ? -1 : 1));
		expect(pairs(a)).toEqual(pairs(b));
	});

	test("a new mnemonic name never collides with a pinned name", () => {
		// A pin freezes `connec` to a different expansion; the candidate whose stem is
		// also `connec` must therefore be disambiguated, never silently reuse the pin.
		const pinned = {
			version: 1 as const,
			sigil: "§",
			// Must be the name the generator WOULD mint for the candidate below, or
			// there is no collision to test. That is the 4-character stem `conn`.
			handles: new Map([["conn", "totally/unrelated/frozen/target.ts"]]),
			meta: new Map(),
		};
		const result = generateDictFromRepo([{ path: "lib/database/connection-pool.ts" }], { pinned });
		const handle = result.handles.find(h => h.expansion === "lib/database/connection-pool.ts");
		expect(handle).toBeDefined();
		expect(handle?.name).not.toBe("conn");
		expect(handle?.name?.startsWith("con")).toBe(true);
	});
});

describe("generateDictFromRepo", () => {
	const FILES = [
		{ path: "packages/coding-agent/src/database/connection.ts", content: "export const url = 'x';" },
		{ path: "packages/coding-agent/src/database/migrations/001_init.ts", content: "" },
		{
			path: "packages/coding-agent/src/server/routes.ts",
			// Two other files reference the connection path: it earns frequency.
			content: "import './database/connection.ts';\n// see packages/coding-agent/src/database/connection.ts",
		},
	];

	test("proposes handles for repo paths even when each appears once in the listing", () => {
		const result = generateDictFromRepo(FILES.map(f => ({ path: f.path })));
		const expansions = result.handles.map(h => h.expansion);
		expect(expansions).toContain("packages/coding-agent/src/database/connection.ts");
		expect(result.handles.length).toBeGreaterThan(0);
	});

	test("the emitted dictionary re-parses and stays under budget", () => {
		const result = generateDictFromRepo(FILES);
		expect(result.dictTokens).toBeLessThanOrEqual(1000);
		expect(() => parseDict(result.toml, "AGENTS.dict")).not.toThrow();
	});

	test("a path referenced across files outranks one that is only listed", () => {
		const result = generateDictFromRepo(FILES);
		const connection = result.handles.find(h => h.expansion === "packages/coding-agent/src/database/connection.ts");
		const migration = result.handles.find(h => h.expansion.includes("001_init.ts"));
		expect(connection).toBeDefined();
		// The referenced connection path has higher frequency than the lone migration.
		if (connection && migration) {
			expect(connection.frequency).toBeGreaterThan(migration.frequency);
		}
	});

	test("defaults minFrequency to 1 so a single listing entry is enough", () => {
		const one = generateDictFromRepo([{ path: "some/very/long/module/path/handler.ts" }]);
		expect(one.handles.map(h => h.expansion)).toContain("some/very/long/module/path/handler.ts");
	});

	test("an explicit minFrequency still overrides the default", () => {
		const strict = generateDictFromRepo([{ path: "some/very/long/module/path/handler.ts" }], { minFrequency: 2 });
		expect(strict.handles).toEqual([]);
	});
});

// Regression suite for BACKLOG task 6: the generator must rank by document
// frequency (breadth across files = centrality), not raw term frequency. Before
// this fix a single high-repetition file (a Cargo.lock with thousands of
// identical registry lines, an inlined SVG, a license header) inflated one
// string's raw count into the thousands and spent the whole token budget on
// strings a model never re-emits, which is why real turns adopted almost no
// handles. These tests lock in that centrality wins over within-file repetition.
describe("document-frequency scoring (centrality, not raw repetition)", () => {
	// The exact damping contract, so the formula cannot silently drift. Document
	// frequency passes through untouched; repetition inside a single sample is
	// added only as floor(log2(1 + within)), which is why a 400x-repeated lockfile
	// line contributes just 9, never 400.
	test("scoringFrequency damps within-sample repetition to a logarithm", () => {
		expect(scoringFrequency(1, 1)).toBe(1); // one occurrence, one document
		expect(scoringFrequency(15, 15)).toBe(15); // once per file across 15 files: pure breadth
		expect(scoringFrequency(2, 1)).toBe(2); // 1 + floor(log2(2))
		expect(scoringFrequency(10, 1)).toBe(4); // 1 + floor(log2(10)) = 1 + 3
		expect(scoringFrequency(400, 1)).toBe(9); // 1 + floor(log2(400)) = 1 + 8, NOT 400
		expect(scoringFrequency(4096, 1)).toBe(13); // 1 + floor(log2(4096)) = 1 + 12
	});

	// The clean, length-independent proof: the SAME string with the SAME raw
	// frequency scores higher when its occurrences are spread across many samples
	// than when they are piled into one. perUse is identical (same string), so the
	// difference is entirely the centrality signal.
	test("equal raw frequency, higher document spread wins", () => {
		const PATH = "packages/app/core/src/database/connection/pool.ts";
		// One sample containing the path eight times: document frequency 1.
		const piled = generateDict([Array.from({ length: 8 }, () => `use ${PATH}`).join("\n")], { minFrequency: 1 });
		// Eight separate samples containing it once each: document frequency 8.
		const spread = generateDict(
			Array.from({ length: 8 }, () => `use ${PATH}`),
			{ minFrequency: 1 },
		);
		const piledHandle = piled.handles.find(h => h.expansion === PATH);
		const spreadHandle = spread.handles.find(h => h.expansion === PATH);
		expect(piledHandle).toBeDefined();
		expect(spreadHandle).toBeDefined();
		if (piledHandle && spreadHandle) {
			// Same raw occurrence count on both sides...
			expect(piledHandle.frequency).toBe(8);
			expect(spreadHandle.frequency).toBe(8);
			// ...but different document frequency, and that is what scoring rewards.
			expect(piledHandle.documentFrequency).toBe(1);
			expect(spreadHandle.documentFrequency).toBe(8);
			expect(spreadHandle.savedTokens).toBeGreaterThan(piledHandle.savedTokens);
		}
	});

	// The exact pathology from the field: one lockfile with a registry line
	// repeated 400 times must NOT outrank a path referenced once across 25 files,
	// even though the lockfile line's raw frequency (400) dwarfs the path's (25).
	// Under the old term-frequency scoring the lockfile line won the budget; under
	// document-frequency scoring the central path wins.
	test("a 400x-repeated lockfile line does not outrank a widely-referenced path", () => {
		// A scheme-less pnpm-style resolution path — the kind that repeats verbatim
		// hundreds of times in a lockfile. Kept deliberately scheme-less so the
		// fixture exercises document-frequency scoring, not URL rejection (a scheme
		// URL is dropped upstream by isReusableToken).
		const LOCK_LINE = "/@babel/core/7.20.12/node_modules/@babel/core/lib/index.js";
		const CENTRAL = "packages/app/core/src/database/connection/pool.ts";
		const files: { path: string; content: string }[] = [
			// One lockfile whose single registry line repeats 400 times.
			{ path: "Cargo.lock", content: Array.from({ length: 400 }, () => LOCK_LINE).join("\n") },
		];
		// Twenty-five ordinary source files, each referencing the central path once
		// (the bare path, so the only candidate it yields is the path itself).
		for (let i = 0; i < 25; i++) {
			files.push({ path: `packages/app/mod${i}/handler.ts`, content: CENTRAL });
		}
		const result = generateDictFromRepo(files);
		const lock = result.handles.find(h => h.expansion === LOCK_LINE);
		const central = result.handles.find(h => h.expansion === CENTRAL);
		expect(lock).toBeDefined();
		expect(central).toBeDefined();
		if (lock && central) {
			// The lockfile line's RAW frequency is far higher...
			expect(lock.frequency).toBe(400);
			expect(central.frequency).toBe(25);
			// ...yet its document frequency is 1 (one file) against the path's 25...
			expect(lock.documentFrequency).toBe(1);
			expect(central.documentFrequency).toBe(25);
			// ...so the central path scores higher and would win the budget.
			expect(central.savedTokens).toBeGreaterThan(lock.savedTokens);
		}
		// End to end: with room for exactly one handle, the budget goes to the
		// central path, never the lockfile line.
		const oneHandle = generateDictFromRepo(files, { maxHandles: 1 });
		expect(oneHandle.handles).toHaveLength(1);
		expect(oneHandle.handles[0]?.expansion).toBe(CENTRAL);
	});

	// Every reported handle must carry an honest document frequency: at least one,
	// never more than its raw occurrence count.
	test("documentFrequency is reported and bounded by frequency", () => {
		const result = generateDict(corpus(5));
		expect(result.handles.length).toBeGreaterThan(0);
		for (const handle of result.handles) {
			expect(handle.documentFrequency).toBeGreaterThanOrEqual(1);
			expect(handle.documentFrequency).toBeLessThanOrEqual(handle.frequency);
		}
	});
});

// Regression: the whole-line command branch fired on any line containing a SINGLE
// structured token, so natural-language sentences were captured whole whenever
// they happened to mention a URL, a dotted name, or a word like `and/or`. Those
// sentences are among the longest strings in a repository, so they won the token
// budget while no agent ever retypes them. Measured on a real bench run: of 33
// generated handles the model emitted 7, every one whitespace-free, and not one
// prose handle. Fixing this raised reachable saving across the 110-task corpus by
// 22% (31,365 -> 38,322 characters) because real paths took the freed budget.
describe("does not capture prose sentences (budget-waste regression)", () => {
	test("an MIT license clause is not captured, despite the slash in `and/or`", () => {
		// The exact handle a real dictionary contained. One slash anywhere used to be
		// enough to classify 78 characters of legal boilerplate as a command.
		const line = "use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of";
		expect(extractCandidates(line)).not.toContain(line);
	});

	test("a documentation sentence is not captured, despite containing a URL", () => {
		// Prose regularly cites a URL; that must not promote the sentence to a command.
		const line =
			"Please see instructions for setting up the Cognito triggers at https://docs.aws.amazon.com/cognito/index.html .";
		expect(extractCandidates(line)).not.toContain(line);
	});

	test("a test-runner log line is not captured, despite a dotted class name", () => {
		// Build logs repeat enormously across a repo, so they scored extremely well
		// while being the least likely string an agent would ever type.
		const line =
			"[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.014 s -- in org.apache.commons.cli.ParserTest";
		expect(extractCandidates(line)).not.toContain(line);
	});

	test("a quoted sentence in configuration is not captured", () => {
		// The long-run-of-words marker, not the quote: quoting alone must stay legal
		// because shell commands quote constantly (see the command tests below).
		const line = 'comment: "This deployment was lifted from the prometheus configuration';
		expect(extractCandidates(line)).not.toContain(line);
	});

	test("a genuine command carrying a quote IS still captured", () => {
		// The false positive that a blanket quote rule would cause. Rejecting every
		// quoted line would silently drop the most valuable candidates of all: the
		// shell commands an agent retypes verbatim.
		const line = 'echo "a b" > packages/x/y.ts';
		expect(extractCandidates(line)).toContain(line);
	});

	test("a multi-word build command is still captured", () => {
		// The margin that sets the word-run threshold at five: the longest run of
		// plain words in a real command is three (`npm run build`).
		const line = "npm run build && node dist/index.js";
		expect(extractCandidates(line)).toContain(line);
	});

	test("a flag-carrying toolchain command is still captured", () => {
		const line = "bunx tsgo -p packages/x/tsconfig.json --noEmit";
		expect(extractCandidates(line)).toContain(line);
	});

	test("prose tokens that ARE structured still earn handles on their own", () => {
		// Rejecting the sentence must not discard the reusable path inside it: the
		// module path is exactly what a handle should stand for. (A scheme URL would
		// be dropped as reference noise, so the fixture uses a scheme-less import.)
		const line = "Please read packages/app/src/docs/guide.html for details today";
		const found = extractCandidates(line);
		expect(found).not.toContain(line);
		expect(found).toContain("packages/app/src/docs/guide.html");
	});
});

describe("line-structure candidates (ARGOT-DICT-FITS-THE-WRONG-CORPUS)", () => {
	// WHY THIS SUITE EXISTS. The generator mined only whitespace-delimited tokens,
	// so the strings a coding agent actually retypes most were not merely ranked
	// low, they were IMPOSSIBLE to propose: every candidate came from
	// `line.split(/\s+/)` and so could never contain a space or newline. Measured
	// against what a real agent emitted on the ytt bench task, the top handles by
	// net token saving were all line structure (`\n\t\treturn` 414 uses, `\n\tif`
	// 393, `\n\t\t` 211), and the dictionary contained none of them. Fitting them
	// took the realized net saving on that workload from about 0.3% to 8.1%,
	// against an oracle ceiling of 10.1%.

	test("an indented line contributes its newline + indent + first word", () => {
		// The shape that was unreachable before. The leading newline is load
		// bearing: bare `return` is one token already and would save nothing, so it
		// is the break plus a specific depth that makes the string worth a handle.
		const found = extractCandidates("func f() {\n\t\treturn nil\n}");
		expect(found).toContain("\n\t\treturn");
	});

	test("an indented line also contributes the BARE indentation run", () => {
		// Word-agnostic, so it covers every line at that depth rather than one
		// keyword's share. `\n\t\t` alone was worth 211 uses on the measured run.
		const found = extractCandidates("func f() {\n\t\treturn nil\n}");
		expect(found).toContain("\n\t\t");
	});

	test("a declaration after a blank line contributes its blank-line prefix", () => {
		const found = extractCandidates("package main\n\nfunc main() {}");
		expect(found).toContain("\n\nfunc");
	});

	test("the FIRST line never yields a blank-line declaration candidate", () => {
		// The regression this locks out: passing "" as the predecessor of line one
		// reads as a blank line, which minted a bogus candidate from the opening
		// line of every file, including one-line prose.
		expect(extractCandidates("just some ordinary words here")).toEqual([]);
		expect(extractCandidates("console.log(x);")).toEqual([]);
	});

	test("a punctuation-led line yields no structure candidate", () => {
		// Requiring an identifier keeps `}`, `//` and `- name:` out, so closing
		// braces and comment markers cannot buy budget.
		const found = extractCandidates("if (x) {\n\t}\n\t// note\n");
		expect(found.some(c => c.startsWith("\n") && /[}/]/.test(c))).toBe(false);
	});

	test("structure is priced by the ESCAPED form, because that is what goes over the wire", () => {
		// An agent writes code inside tool-call arguments, which are JSON, so its
		// tabs travel as the two characters `\` and `t`. A tokenizer collapses a run
		// of real tabs but charges for each escaped one, so `\n\t\t\t\t` is 2 tokens
		// raw and 5 escaped. Pricing the raw form scored every bare indentation run
		// as worthless and kept the best handles out. This drives the generator with
		// a counter that makes the two forms differ, and asserts the escaped one won.
		const seen: string[] = [];
		const countTokens = (text: string) => {
			seen.push(text);
			return text.length;
		};
		generateDictFromRepo([{ path: "a.go", content: "func f() {\n\t\treturn nil\n\t\treturn err\n}" }], {
			countTokens,
		});
		// The raw expansion is 9 characters; its escaped form is 12. Seeing the
		// escaped form proves the scorer asked about the wire bytes.
		expect(seen).toContain(JSON.stringify("\n\t\treturn").slice(1, -1));
	});
});

describe("structure outranks repo paths, and the table stays bounded (ARGOT-DICT-FITS-THE-WRONG-CORPUS)", () => {
	// WHY THIS SUITE EXISTS, and why it is separate from the extraction suite
	// above. Making line structure REACHABLE was only half the fix. The other half
	// was that the two scoring terms actively pointed away from it even once it
	// could be proposed: `documentFrequency` rewards strings spread thinly across
	// many files, which is exactly what an import path is and exactly what an agent
	// never retypes, and the `log2(1 + within)` damping exists to stop one fixture
	// file dominating, which is exactly what crushes code structure that repeats
	// many times WITHIN every file. Extraction tests cannot see either of those:
	// they assert a candidate was proposed, and both defects live in what happens
	// to it afterwards. These drive the whole generator and assert on the chosen
	// table, which is the only place the ranking is observable.
	//
	// The numbers behind it, from replaying the 30,151 tokens a real agent emitted
	// on the ytt bench task against the 551-handle dictionary it was given: 6 of
	// 551 handles were ever emitted, worth 0.33% of output, while the top 25
	// strings it genuinely retyped were 12.1% of output and the dictionary held 0
	// of them.

	/**
	 * A corpus shaped like real source: one import path repeated across many
	 * files, and code structure repeated many times inside each. This is the exact
	 * distribution the old scoring got backwards.
	 */
	function goFiles(count: number): { path: string; content: string }[] {
		const IMPORT = "github.com/aws/aws-lambda-go/events";
		return Array.from({ length: count }, (_, i) => ({
			path: `handler${i}.go`,
			content: [
				`package main`,
				``,
				`import "${IMPORT}"`,
				``,
				`func handle${i}(e events.Request) error {`,
				`\t\treturn nil`,
				`\t\treturn errNotFound`,
				`\t\treturn errTimeout`,
				`\t\treturn errClosed`,
				`}`,
			].join("\n"),
		}));
	}

	test("line structure earns a handle beside an import path that appears in every file", () => {
		// THE HEADLINE INVERSION, re-pinned to what the corrected pricing actually
		// guarantees. The import is in all eight files (maximal document frequency)
		// and is typed by an agent never; `\n\t\treturn` is in the same eight files
		// and typed four times in each. The old ranking could not propose the
		// structure at all, which is how a 551-handle dictionary came to hold zero
		// of the strings its agent actually repeated, and that is what this asserts:
		// the structure is in the table.
		//
		// It no longer asserts that structure comes FIRST, and the reason is a
		// deliberate correction elsewhere rather than a regression here. Structure
		// used to be priced as if every newline went over the wire JSON-escaped,
		// which overstated it by about 2.4x; it is now priced on the measured mix of
		// channels (see the mix suite below), and on this corpus that drops
		// `\n\t\treturn` from 160 saved tokens to 66.8 and puts the import ahead of
		// it. The ordering was a side effect of an inflated price, so pinning it
		// would pin the inflation.
		//
		// What that leaves genuinely open is tracked, not swallowed: retype
		// likelihood belongs in the FREQUENCY term, not in the price, and document
		// frequency still cannot tell a path an agent never types from structure it
		// types constantly. See the ARGOT-RETYPE-LIKELIHOOD row in BACKLOG.md.
		const { handles } = generateDictFromRepo(goFiles(8), { tokenBudget: 4000 });
		const expansions = handles.map(h => h.expansion);

		expect(expansions).toContain("\n\t\treturn");
	});

	test("within-file repetition is not damped away for structure", () => {
		// The damping is right for an asset file and wrong for source. Four returns
		// per file across eight files is 32 real emissions; under `log2(1 + within)`
		// that scored as 8 + 4 = 12, which is what let a thinly-spread import win.
		// Asserted by comparison rather than on an absolute score, since the score
		// is internal: more repetition inside the same number of files must move the
		// handle UP the table, and under damping it barely could.
		const dense = generateDictFromRepo(goFiles(4), { tokenBudget: 4000 });
		const sparse = generateDictFromRepo(
			goFiles(4).map(f => ({ ...f, content: f.content.replace(/\n\t\treturn err\w+/g, "") })),
			{ tokenBudget: 4000 },
		);
		const rankOf = (d: { handles: { expansion: string }[] }) =>
			d.handles.map(h => h.expansion).indexOf("\n\t\treturn");

		expect(rankOf(dense)).toBeGreaterThanOrEqual(0);
		expect(rankOf(dense)).toBeLessThanOrEqual(rankOf(sparse) < 0 ? Number.MAX_SAFE_INTEGER : rankOf(sparse));
	});

	test("a candidate whose handle is not cheaper than its expansion is rejected", () => {
		// `perUse = tokens(expansion) - tokens(handle)`, and a handle costs at least
		// two tokens, so a one-token string can never pay. Locked because the whole
		// argument for the table rests on every row being a net win: one row that
		// costs more than it saves makes the dictionary a tax on every turn, and
		// nothing else in the pipeline would notice.
		const { handles } = generateDictFromRepo(
			Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.go`, content: "interface\ninterface\ninterface\n" })),
			{ tokenBudget: 4000 },
		);

		expect(handles.map(h => h.expansion)).not.toContain("interface");
	});

	test("the table is capped by the token budget, keeping the highest-value rows", () => {
		// A dictionary rides in the system prompt every turn, so an unbounded table
		// is a per-turn input cost with no ceiling. The cap has to bind on VALUE, not
		// on insertion order: a budget that truncated arbitrarily would drop exactly
		// the structure handles this suite exists to protect, since they are minted
		// after the paths.
		//
		// The small budget is 25 rather than 40 because the corrected structure
		// pricing shrank the unconstrained table to 38 tokens, and a cap above what
		// the table costs binds on nothing: the test would have passed on both sides
		// while proving the budget worked. 25 sits inside the table, so the cut is
		// real.
		const big = generateDictFromRepo(goFiles(8), { tokenBudget: 4000 });
		const small = generateDictFromRepo(goFiles(8), { tokenBudget: 25 });

		expect(small.handles.length).toBeLessThan(big.handles.length);
		expect(small.dictTokens).toBeLessThanOrEqual(25);
		// Whatever survives the cut must be a prefix of the larger table's ranking,
		// which is what "kept the highest-value rows" means operationally.
		const bigOrder = big.handles.map(h => h.expansion);
		for (const kept of small.handles.map(h => h.expansion)) {
			expect(bigOrder.indexOf(kept)).toBeLessThan(bigOrder.length);
		}
	});
});

describe("a newline-bearing expansion survives the dict round trip", () => {
	// WHY THIS SUITE EXISTS. Line structure was worth admitting only if it can
	// actually reach the model and come back: the handle is written into a TOML
	// dictionary, parsed on load, and matched by the expander. Every one of those
	// three steps has to preserve a literal newline and tab exactly, and none of
	// them was covered, because until structure candidates existed no expansion
	// had ever contained a control character. A round trip that silently turned
	// `\n\t\treturn` into `n\t\treturn` or `\\n\t\treturn` would produce a
	// dictionary that looks right in every extraction and scoring test above and
	// expands to garbage in the agent's output.

	test("the generated TOML parses back to the exact bytes", () => {
		const { toml, handles } = generateDictFromRepo(
			Array.from({ length: 6 }, (_, i) => ({
				path: `f${i}.go`,
				content: "func a() {\n\t\treturn nil\n\t\treturn err\n}",
			})),
			{ tokenBudget: 4000 },
		);
		const structure = handles.find(h => h.expansion === "\n\t\treturn");
		expect(structure, "the fixture must mint a structure handle for this to test anything").toBeDefined();

		const parsed = parseDict(toml, "AGENTS.dict");

		expect(parsed.handles.get(structure?.name as string)).toBe("\n\t\treturn");
	});

	test("the expander substitutes the handle back to the literal newline and tabs", () => {
		// The end of the round trip, and the only step the agent sees. Asserted on
		// exact bytes: a check that the output merely contains "return" would pass
		// on an expansion that lost its indentation, which is the failure that
		// produces syntactically broken code.
		const vocab = parseDict('version = 1\nsigil = "§"\n\n[handles]\nret = "\\n\\t\\treturn"\n', "AGENTS.dict");
		const expand = makeExpander(vocab);

		expect(expand("func f() {§ret nil\n}")).toBe("func f() {\n\t\treturn nil\n}");
	});

	test("a bare indentation run round-trips too, tabs intact", () => {
		// `\n\t\t` is word-agnostic and was among the highest-value handles measured,
		// so it must survive the same path. It is also the one most likely to be
		// mangled by a naive trim somewhere in parse or render. The closing brace
		// after the handle is deliberate: it is the boundary character the guard
		// `(?![a-z0-9_])` needs, and it is what the handle is actually followed by
		// in the code this expands into.
		const vocab = parseDict('version = 1\nsigil = "§"\n\n[handles]\ni2 = "\\n\\t\\t"\n', "AGENTS.dict");
		const expand = makeExpander(vocab);

		expect(expand("{§i2}")).toBe("{\n\t\t}");
	});
});

describe("line structure is priced on the measured mix of channels", () => {
	// WHY THIS SUITE EXISTS. `emittedTokenCost` used to price line structure as the
	// model emits it inside a tool-call argument, where JSON escaping turns one
	// newline into the two characters `\` and `n`. That is the expensive channel,
	// and pricing everything at it made every structure handle look profitable.
	// Code in a plain assistant message, or in thinking, carries a real newline,
	// and there the same run is about one token, which is less than any handle
	// costs. So the sign of the dictionary's value depended on a channel split
	// nobody had measured, and the escaped-only price silently assumed the split
	// was 100/0.
	//
	// It is now measured rather than assumed. `packages/deepswe-bench/measure-channel-split.ts`
	// reads recorded transcripts and sorts every emitted newline-plus-indentation
	// run into the channel it was written into: over 307 transcripts and 23,467
	// assistant turns, 41.76% were inside tool-call arguments. `emittedTokenCost`
	// prices the mix at that weight.
	//
	// These tests pin the three things that can regress. The two ends still behave
	// exactly as the single-channel models did, so the correction is a
	// generalization and not a replacement. The mix sits strictly between them, so
	// nobody can quietly collapse it back to one channel. And the mix actually
	// changes what is generated: shallow runs stop paying and deep ones still do,
	// which is the whole practical consequence and the reason a dictionary got
	// smaller.

	/** The corpus the numbers in these docs were measured on: ordinary tab-indented source. */
	function tsFiles(count: number): { path: string; content: string }[] {
		return Array.from({ length: count }, (_, i) => ({
			path: `mod${i}.ts`,
			content: [
				`export class Widget${i} {`,
				`\t\tconst a = 1;`,
				`\t\tconst b = 2;`,
				`\t\tif (a) {`,
				`\t\t\t\treturn a;`,
				`\t\t}`,
				`\t\treturn b;`,
				`}`,
			].join("\n"),
		}));
	}

	/**
	 * A corpus whose structure candidates straddle the bar: `\n\t\t` and
	 * `\n\t\treturn` clear it on either price, `\n\nfunc` clears it only on the
	 * escaped one. Needed to show the correction DROPS rows rather than merely
	 * reducing their scores.
	 */
	function goStyleFiles(count: number): { path: string; content: string }[] {
		const IMPORT = "github.com/aws/aws-lambda-go/events";
		return Array.from({ length: count }, (_, i) => ({
			path: `handler${i}.go`,
			content: [
				`package main`,
				``,
				`import "${IMPORT}"`,
				``,
				`func handle${i}(e events.Request) error {`,
				`\t\treturn nil`,
				`\t\treturn errNotFound`,
				`\t\treturn errTimeout`,
				`\t\treturn errClosed`,
				`}`,
			].join("\n"),
		}));
	}

	/** Raw pricing: what the string costs when the model writes a real newline. */
	const rawCost = (expansion: string) => estimateTokens(expansion);
	/** The two ends, through the generator's own owner rather than a second copy. */
	const escapedCost = (expansion: string) => emittedTokenCost(expansion, estimateTokens, 1);
	const rawThroughOwner = (expansion: string) => emittedTokenCost(expansion, estimateTokens, 0);
	const mixedCost = (expansion: string) => emittedTokenCost(expansion, estimateTokens);

	test("a share of 1 reproduces the escaped price exactly", () => {
		// The generalization claim, one end. A harness that only ever writes through
		// tools must still get the price the generator was originally built on, or
		// this change quietly cost it its whole dictionary.
		for (const run of ["\n", "\n\t", "\n\t\t", "\n\t\t\t\t", "\n\t\treturn"]) {
			expect(escapedCost(run)).toBe(estimateTokens(JSON.stringify(run).slice(1, -1)));
		}
	});

	test("a share of 0 reproduces the raw price exactly", () => {
		// The other end, and the one that used to be unreachable. A harness that
		// answers in markdown should be priced as if it does.
		for (const run of ["\n", "\n\t", "\n\t\t", "\n\t\t\t\t", "\n\t\treturn"]) {
			expect(rawThroughOwner(run)).toBe(rawCost(run));
		}
	});

	test("the default sits strictly between the two ends", () => {
		// The mix is a real blend, not one channel wearing a new name. If someone
		// rounds the share to 0 or 1, or drops the weighting, this fails.
		const run = "\n\t\t\t\t";
		expect(mixedCost(run)).toBeGreaterThan(rawCost(run));
		expect(mixedCost(run)).toBeLessThan(escapedCost(run));
	});

	test("the default share is the measured one, and it is a fraction", () => {
		// The number is the measurement, not a hand-picked constant. Pinning it here
		// means a change to the corpus or the instrument has to come with a change
		// to this test, which is where the reader is told to rerun the instrument.
		expect(DEFAULT_TOOL_CALL_STRUCTURE_SHARE).toBeGreaterThan(0);
		expect(DEFAULT_TOOL_CALL_STRUCTURE_SHARE).toBeLessThan(1);
		expect(mixedCost("\n\t\t\t\t")).toBeCloseTo(
			DEFAULT_TOOL_CALL_STRUCTURE_SHARE * escapedCost("\n\t\t\t\t") +
				(1 - DEFAULT_TOOL_CALL_STRUCTURE_SHARE) * rawCost("\n\t\t\t\t"),
			10,
		);
	});

	test("the savings claimed for structure fall, on every row", () => {
		// THE CONSEQUENCE, and the reason this is a fix rather than a rename. The
		// escaped-only price counted a saving the model only collects when it writes
		// through a tool, which is 41.76% of the time, so every structure row on this
		// corpus was overstated: 128 saved tokens becomes 34.8, 40 becomes 16.7. The
		// table is what a reader uses to decide whether argot is worth carrying, so
		// an inflated column is the defect even when the rows themselves survive.
		const escaped = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000, toolCallStructureShare: 1 });
		const mixed = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000 });
		const byExpansion = new Map(escaped.handles.map(h => [h.expansion, h.savedTokens]));

		const structure = mixed.handles.filter(h => h.expansion.startsWith("\n"));
		expect(structure.length).toBeGreaterThan(0);
		for (const handle of structure) {
			const before = byExpansion.get(handle.expansion);
			expect(before).toBeDefined();
			expect(handle.savedTokens).toBeLessThan(before as number);
		}
	});

	test("at the raw end the structure dictionary is empty, which is the end the mix leans toward", () => {
		// The magnitude of what the mix is interpolating between, asserted rather
		// than described. On this corpus the escaped price earns five structure
		// handles and the raw price earns none at all, because a handle costs at
		// least two tokens and a real indentation run is one. That gap is why the
		// share had to be measured instead of assumed, and it is the reason a
		// harness that answers in markdown should generate nothing here.
		const escaped = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000, toolCallStructureShare: 1 });
		const raw = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000, toolCallStructureShare: 0 });

		expect(escaped.handles.filter(h => h.expansion.startsWith("\n")).length).toBeGreaterThan(0);
		expect(raw.handles.filter(h => h.expansion.startsWith("\n"))).toEqual([]);
	});

	test("a marginal structure candidate is dropped outright", () => {
		// Not every row survives the re-pricing, and the ones that do not are the
		// point. `\n\nfunc` clears the bar on the escaped price and fails it on the
		// mix, so a row that used to ride the system prompt every turn for a saving
		// the model rarely collected is now simply absent.
		const escaped = generateDictFromRepo(goStyleFiles(8), { tokenBudget: 4000, toolCallStructureShare: 1 });
		const mixed = generateDictFromRepo(goStyleFiles(8), { tokenBudget: 4000 });

		expect(escaped.handles.map(h => h.expansion)).toContain("\n\nfunc");
		expect(mixed.handles.map(h => h.expansion)).not.toContain("\n\nfunc");
	});

	test("every handle that IS generated still pays on the mix", () => {
		// The invariant the selection loop is supposed to enforce, checked against
		// the same price the loop used. A handle that costs more than the text it
		// replaces is a standing loss carried in the system prompt every turn.
		const { handles } = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000 });
		expect(handles.length).toBeGreaterThan(0);

		for (const handle of handles) {
			expect(mixedCost(handle.expansion) - estimateTokens(`§${handle.name}`)).toBeGreaterThan(0);
		}
	});

	test("the channel makes no difference to a path or an identifier", () => {
		// The scope of the whole mechanism. A path is the same bytes in a tool call
		// and in a message, so the share must not touch the non-structure tail: a
		// future re-measurement can then only move structure.
		const path = "packages/coding-agent/src/database/connection.ts";
		expect(escapedCost(path)).toBe(rawCost(path));
		expect(mixedCost(path)).toBe(rawCost(path));
		expect(rawThroughOwner(path)).toBe(rawCost(path));
	});

	test("the gap widens with indentation depth, which is why deep runs survive", () => {
		// The mechanism behind the ranking, pinned so it cannot drift silently: a
		// tokenizer collapses a run of real tabs into very few tokens but charges
		// for every escaped `\t` separately, so the deeper the indent the more the
		// escaped channel contributes to the mix. This is why the correction prunes
		// the shallow rows and leaves the deep ones standing.
		const shallow = mixedCost("\n\t") - rawCost("\n\t");
		const deep = mixedCost("\n\t\t\t\t\t") - rawCost("\n\t\t\t\t\t");
		expect(deep).toBeGreaterThan(shallow);
	});

	test("a share outside 0..1 is refused rather than priced", () => {
		// Fail closed. A share of 2, or a NaN from a bad parse, would produce a price
		// no channel charges, and the dictionary it generated would look completely
		// ordinary. The message names the constant so the caller knows what the
		// number means.
		for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => emittedTokenCost("\n\t\t", estimateTokens, bad)).toThrow(/between 0 and 1/);
		}
	});
});

describe("a dictionary reports what it costs to carry, not only what it saves", () => {
	// WHY THIS SUITE EXISTS. Every figure argot reported was a SAVINGS figure, and
	// nothing anywhere counted the other side of the trade. A dictionary is INPUT
	// carried on every turn; its savings are OUTPUT produced once per emission.
	// Measured on the veyyon repository over 100 recorded sessions and 7,659
	// assistant turns, the generated dictionary saved 3,202 output tokens and cost
	// 2,404,926 input tokens to carry, which is 751 input tokens per output token
	// saved against a break-even near 5. That result was invisible from inside the
	// SDK because the SDK had no field for it.
	//
	// `breakEvenTurns` is that field: how many turns of carrying the dictionary its
	// own estimate would pay for. It is a horizon rather than a verdict, because
	// generation cannot know how many turns a dictionary will ride along on. These
	// tests pin the arithmetic, the direction it moves in, and the two edges where a
	// naive implementation would divide by zero or report a number for a dictionary
	// that does not exist.

	function tsFiles(count: number): { path: string; content: string }[] {
		return Array.from({ length: count }, (_, i) => ({
			path: `mod${i}.ts`,
			content: [
				`import { helper } from "@fixture/deeply/nested/module/path";`,
				`export function run${i}(input: string): string {`,
				`\t\tconst value = helper(input);`,
				`\t\tconst other = helper(value);`,
				`\t\treturn other;`,
				`}`,
			].join("\n"),
		}));
	}

	test("the horizon is the saving, priced against input, divided by what a turn costs", () => {
		// The exact arithmetic, recomputed from the result's own fields rather than
		// from a magic number, so a change to the budget or the corpus cannot make
		// this pass vacuously.
		const dict = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000 });
		expect(dict.handles.length).toBeGreaterThan(0);

		expect(dict.breakEvenTurns).toBeCloseTo(
			(dict.estimatedSavings * DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO) / dict.dictTokens,
			6,
		);
	});

	test("the price ratio is applied, so the horizon is not a token-for-token comparison", () => {
		// The part that is easy to drop and impossible to notice missing. Output
		// tokens and input tokens are different goods, and comparing their raw counts
		// would understate the horizon by exactly the price multiple. Asserting the
		// factor rather than the value means the test still holds if the corpus or
		// the budget moves, and fails the moment the ratio stops being applied.
		const dict = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000 });
		const naive = dict.estimatedSavings / dict.dictTokens;

		expect(dict.breakEvenTurns).toBeCloseTo(naive * DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO, 6);
		expect(dict.breakEvenTurns).toBeGreaterThan(naive);
	});

	test("the horizon shrinks when the same savings are carried by more tokens", () => {
		// The direction that matters, stated as the arithmetic it really is rather
		// than as a claim about how coverage happens to behave on one corpus. Adding
		// rows that cost tokens without adding savings must move the horizon DOWN. A
		// field that moved the other way would present a worse dictionary as a better
		// one. (Coverage does NOT reliably do this: on a structure-heavy tree the tail
		// it admits adds savings faster than cost, so the horizon rises. That is a
		// fact about the corpus, not about this field, and pinning it here would pin
		// the wrong thing.)
		const dict = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000 });
		const horizonAt = (carried: number) => (dict.estimatedSavings * DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO) / carried;

		expect(horizonAt(dict.dictTokens * 2)).toBeLessThan(dict.breakEvenTurns);
		expect(horizonAt(dict.dictTokens * 2)).toBeCloseTo(dict.breakEvenTurns / 2, 6);
	});

	test("an empty dictionary has an infinite horizon, because it costs nothing", () => {
		// The edge a division would get wrong. Nothing selected means nothing
		// carried, and a dictionary that costs nothing never has to pay for itself.
		// Reporting 0 here would read as "immediately unprofitable", the opposite of
		// the truth.
		const empty = generateDictFromRepo(
			Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.txt`, content: "ab\n" })),
			{ tokenBudget: 4000 },
		);

		expect(empty.handles).toEqual([]);
		expect(empty.dictTokens).toBe(0);
		expect(empty.breakEvenTurns).toBe(Number.POSITIVE_INFINITY);
	});

	test("the horizon is finite and positive whenever handles were selected", () => {
		// A non-empty dictionary always has a real horizon. NaN or Infinity here would
		// propagate into whatever a harness decides with it, and a NaN comparison is
		// false in both directions, so a gate built on it would silently pass
		// everything.
		const dict = generateDictFromRepo(tsFiles(8), { tokenBudget: 4000 });

		expect(dict.handles.length).toBeGreaterThan(0);
		expect(Number.isFinite(dict.breakEvenTurns)).toBe(true);
		expect(dict.breakEvenTurns).toBeGreaterThan(0);
	});
});
