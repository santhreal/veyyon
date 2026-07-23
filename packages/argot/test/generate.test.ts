import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import { HANDLE_NAME_RE, MAX_EXPANSION_BYTES } from "../src/constants.js";
import {
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
	// punctuation while still keeping genuine paths, imports, and URLs.
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

		test("a URL IS still captured", () => {
			expect(extractCandidates("fetch https://rubygems.org/api/v1/gems then")).toContain(
				"https://rubygems.org/api/v1/gems",
			);
		});

		test("a home-relative path IS still captured", () => {
			expect(extractCandidates("look in ~/.omp/agent/extensions/ folder")).toContain("~/.omp/agent/extensions/");
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

	test("a uniquely-stemmed path gets the bare 6-char stem, no hash", () => {
		const result = generateDictFromRepo([{ path: "lib/database/connection-pool.ts" }]);
		const handle = result.handles.find(h => h.expansion === "lib/database/connection-pool.ts");
		// last segment `connection-pool.ts` → strip non-alnum → truncate 6 → `connec`.
		expect(handle?.name).toBe("connec");
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
			expect(name.startsWith("connec")).toBe(true);
			expect(name.length).toBeLessThanOrEqual("connec".length + 4);
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
			handles: new Map([["connec", "totally/unrelated/frozen/target.ts"]]),
			meta: new Map(),
		};
		const result = generateDictFromRepo([{ path: "lib/database/connection-pool.ts" }], { pinned });
		const handle = result.handles.find(h => h.expansion === "lib/database/connection-pool.ts");
		expect(handle).toBeDefined();
		expect(handle?.name).not.toBe("connec");
		expect(handle?.name?.startsWith("connec")).toBe(true);
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
		const LOCK_LINE = "registry+https://github.com/rust-lang/crates.io-index";
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
