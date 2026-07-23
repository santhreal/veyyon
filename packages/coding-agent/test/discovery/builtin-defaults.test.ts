/**
 * The bundled `builtin-defaults` rule provider ships a curated default rule set
 * embedded into the binary. These tests defend that the whole set loads and
 * parses, and that the provider sits at the lowest priority so any user/project
 * rule of the same name overrides a bundled default (first-wins dedup).
 */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@veyyon/coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@veyyon/coding-agent/capability/rule";
import type { LoadContext } from "@veyyon/coding-agent/capability/types";
import { BUILTIN_RULE_SOURCES } from "@veyyon/coding-agent/discovery/builtin-rules/index";
import { prompt } from "@veyyon/utils";
// Register all discovery providers as a side effect.
import "@veyyon/coding-agent/discovery";
import { TtsrManager, type TtsrMatchContext } from "@veyyon/coding-agent/export/ttsr";

function ruleProvider() {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	return { cap, provider };
}

async function loadBuiltinRules(): Promise<Rule[]> {
	const { provider } = ruleProvider();
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

describe("builtin-defaults rule provider", () => {
	it("loads the bundled default rule set, all attributed to the provider", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
		const names = rules.map(r => r.name);
		// Name-based dedup is first-wins, so a duplicate would be silently shadowed.
		expect(new Set(names).size).toBe(names.length);
	});

	it("parses every bundled rule as a TTSR rule (non-empty condition/astCondition and scope)", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			const conditionCount = (rule.condition?.length ?? 0) + (rule.astCondition?.length ?? 0);
			expect(conditionCount, `${rule.name} condition/astCondition`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
		}
	});

	it("bundles ast-grep conditions for the redundant-clear-guard rule", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-redundant-clear-guard");
		expect(rule?.condition).toBeUndefined();
		expect(rule?.astCondition?.length).toBeGreaterThan(0);
	});

	it("parses YAML list-form conditions from the embedded text", async () => {
		const rules = await loadBuiltinRules();
		const lazylock = rules.find(r => r.name === "rs-lazylock");
		// Frontmatter declares two condition patterns as a YAML sequence.
		expect(lazylock?.condition).toHaveLength(2);
	});

	it("preserves a per-rule interruptMode override from frontmatter", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.find(r => r.name === "ts-set-map")?.interruptMode).toBe("never");
	});

	it("cwd-reroot fires on an absolute foreign path in a navigation call, not on relative/URI/edit calls", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "cwd-reroot");
		if (!rule) throw new Error("cwd-reroot rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		// A read/grep/glob call carrying a deep absolute path (the shape produced only
		// when reaching into another project) fires the nudge on each nav tool.
		const foreign =
			'{"path":"/media/mukund-thiru/SanthData/Santh/software/keyhog/crates/cli/src/subcommands/calibrate_autoroute.rs:1-260"}';
		for (const toolName of ["read", "grep", "glob", "ast_grep"]) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(foreign, { source: "tool", toolName }).map(r => r.name),
				toolName,
			).toEqual(["cwd-reroot"]);
		}

		// In-cwd work uses short RELATIVE paths, which carry no leading slash and never fire.
		for (const relative of [
			'{"path":"src/tools/read.ts"}',
			'{"path":"packages/coding-agent/src/tools/read.ts:1-40"}',
		]) {
			manager.resetBuffer();
			expect(manager.checkDelta(relative, { source: "tool", toolName: "read" }), relative).toEqual([]);
		}

		// Internal URIs (scheme://a/b/c/d) look path-like but must not fire: the leading
		// slashes sit after a scheme colon or a word char, never after a real delimiter.
		for (const uri of ['{"path":"skill://a/b/c/d/e"}', '{"path":"mcp://server/tool/a/b/c"}']) {
			manager.resetBuffer();
			expect(manager.checkDelta(uri, { source: "tool", toolName: "read" }), uri).toEqual([]);
		}

		// Out of scope: an edit call embedding an absolute path in its content is not a
		// navigation call and must not trip the re-root nudge.
		manager.resetBuffer();
		expect(manager.checkDelta(foreign, { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] })).toEqual([]);
	});

	// Regression for BUG-CWD-REROOT-ARGOT-LEAK-DEFAULT: bundled rules are ALWAYS
	// active (they gate on a TTSR condition, never on a feature flag), but argot is
	// experimental and `argot.enabled` defaults to false, so the argot_load tool is
	// not even registered by default. A rule that mentions argot MUST wrap that
	// mention in a `{{#if argot}}` gate, which #getTtsrInjectionContent resolves
	// against the live `argot.enabled` flag before injecting the body. So with the
	// flag OFF the rendered body must carry no argot mention at all (no dead advice
	// to call a tool that does not exist); an ungated `argot` in a rule body is the
	// leak this guards against.
	describe("bundled rules never leak argot advice when argot is off", () => {
		it("every rule body rendered with argot=false contains no argot mention", () => {
			const leaks = BUILTIN_RULE_SOURCES.filter(({ content }) =>
				/argot/i.test(prompt.render(content, { argot: false })),
			).map(r => r.name);
			expect(leaks).toEqual([]);
		});

		it("cwd-reroot's argot_load advice appears only when argot is on (the gate actually passes content through)", () => {
			const cwdReroot = BUILTIN_RULE_SOURCES.find(r => r.name === "cwd-reroot");
			if (!cwdReroot) throw new Error("cwd-reroot rule missing");
			expect(prompt.render(cwdReroot.content, { argot: false })).not.toMatch(/argot_load/);
			expect(prompt.render(cwdReroot.content, { argot: true })).toContain("argot_load");
		});
	});

	// Regression for HUNT-rule-importtype-dynamic: the old condition was the bare
	// `import\(`, a substring of every runtime `await import("./mod")`, so a valid
	// dynamic value import matched AND (interruptMode defaulting to "always")
	// aborted the stream. The condition now requires a member access on the import
	// (`import(...).X`), which is the inline-type-import shape, and interruptMode is
	// "never" so a residual match only advises, never aborts.
	it("fires ts-import-type on inline type imports but not on runtime dynamic imports", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-import-type");
		if (!rule) throw new Error("ts-import-type rule missing");
		expect(rule.interruptMode).toBe("never");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		// Inline type imports (member access on the import) DO fire.
		for (const snippet of ['function f(c: import("some-sdk").Client) {}', 'type T = import("./types").Config;']) {
			manager.resetBuffer();
			expect(
				manager
					.checkDelta(snippet, { source: "tool", toolName: "write", filePaths: ["src/foo.ts"] })
					.map(r => r.name),
				snippet,
			).toEqual(["ts-import-type"]);
		}

		// Runtime dynamic value imports must NOT fire (the false-positive/abort bug).
		for (const snippet of [
			'const m = await import("./mod");',
			'await import("node:fs");',
			'return import("./lazy");',
		]) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(snippet, { source: "tool", toolName: "write", filePaths: ["src/foo.ts"] }),
				snippet,
			).toEqual([]);
		}
	});

	// Regression for HUNT-rule-noany-wordboundary: `: any|as any` lacked a trailing
	// word boundary, so it matched inside longer identifiers (`: anyOf<T>`,
	// `as anyMock`). The condition now ends each alternative with `\b`.
	it("fires ts-no-any on real any annotations but not on identifiers that merely start with 'any'", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-any");
		if (!rule) throw new Error("ts-no-any rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of ["const x: any = 1;", "return v as any;"]) {
			manager.resetBuffer();
			expect(
				manager
					.checkDelta(snippet, { source: "tool", toolName: "write", filePaths: ["src/foo.ts"] })
					.map(r => r.name),
				snippet,
			).toEqual(["ts-no-any"]);
		}

		// `any` as the head of a longer identifier is not the `any` type.
		for (const snippet of ["const x: anyOf<T> = f();", "const y = v as anyMockClient;"]) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(snippet, { source: "tool", toolName: "write", filePaths: ["src/foo.ts"] }),
				snippet,
			).toEqual([]);
		}
	});

	it("fires the no-test-timers rule on real timers in *.test.ts but not plain *.ts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-test-timers");
		if (!rule) throw new Error("ts-no-test-timers rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of ["await Bun.sleep(10)", "setTimeout(fn, 0)", "setInterval(fn, 5)"]) {
			manager.resetBuffer();
			const matches = manager.checkDelta(snippet, {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/test/foo.test.ts"],
			});
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-test-timers"]);
		}

		// Same content in a non-test file is out of scope.
		manager.resetBuffer();
		expect(
			manager.checkDelta("await Bun.sleep(10)", {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("fires ts-no-inline-cast-access on inline cast-and-access but not named-type casts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-inline-cast-access");
		if (!rule) throw new Error("ts-no-inline-cast-access rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		// AST conditions only run on edit/write streams, with the language inferred from the path.
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

		// Inline object-type assertion immediately read — every access form is flagged.
		const violations = [
			"const a = (value as { content: unknown }).content;",
			"const b = (value as { content: unknown })?.content;",
			'const c = (opts as { enabled: boolean })["enabled"];',
			"const d = (value as unknown as { content: unknown }).content;",
		];
		for (const snippet of violations) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-inline-cast-access"]);
		}

		// A cast to a named type, plain member access, and a bare cast (no read) are all left alone.
		const allowed = [
			"const e = (value as Foo).bar;",
			"const f = obj.content;",
			"const g = value as { content: unknown };",
		];
		for (const snippet of allowed) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(matches, snippet).toEqual([]);
		}

		// Out of scope: the same violation in a non-TS file never reaches the matcher.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot("const h = (value as { content: unknown }).content;", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/foo.js"],
			}),
		).toEqual([]);
	});
	it("go-new-expr matches value→pointer helpers (named + generic) but not real functions, only on *.go", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-new-expr");
		if (!rule) throw new Error("go-new-expr rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] };

		const hits = [
			"package p\nfunc boolPtr(v bool) *bool { return &v }",
			"package p\nfunc Ptr[T any](v T) *T { return &v }",
		];
		for (const snippet of hits) {
			manager.resetBuffer();
			expect(
				(await manager.checkAstSnapshot(snippet, ctx)).map(m => m.name),
				snippet,
			).toEqual(["go-new-expr"]);
		}

		const misses = [
			"package p\nfunc add(a int, b int) *int { return &a }",
			"package p\nfunc (s *S) Get() *int { return &s.x }",
		];
		for (const snippet of misses) {
			manager.resetBuffer();
			expect(await manager.checkAstSnapshot(snippet, ctx), snippet).toEqual([]);
		}

		// AST conditions never reach a non-go path.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot(hits[0], { source: "tool", toolName: "edit", filePaths: ["pkg/foo.ts"] }),
		).toEqual([]);
	});

	it("go-bench-loop fires on a *testing.B b.N loop but not an ordinary .N counter", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-bench-loop");
		if (!rule) throw new Error("go-bench-loop rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["pkg/foo_test.go"] };

		const bench =
			"package p\nfunc BenchmarkX(b *testing.B) {\n\tsetup()\n\tfor i := 0; i < b.N; i++ {\n\t\twork()\n\t}\n}";
		manager.resetBuffer();
		expect((await manager.checkAstSnapshot(bench, ctx)).map(m => m.name)).toEqual(["go-bench-loop"]);

		// A `.N` selector on something that is not the benchmark receiver must not fire.
		const helper =
			"package p\nfunc TestThing(t *testing.T) {\n\treq := build()\n\tfor i := 0; i < req.N; i++ {\n\t\twork()\n\t}\n}";
		manager.resetBuffer();
		expect(await manager.checkAstSnapshot(helper, ctx)).toEqual([]);
	});

	it("go-range-int fires only on *.go, never on a same-named non-go path", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-range-int");
		if (!rule) throw new Error("go-range-int rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		const loop = "package p\nfunc f(n int) {\n\tfor i := 0; i < n; i++ {\n\t\tuse(i)\n\t}\n}";
		manager.resetBuffer();
		expect(
			(await manager.checkAstSnapshot(loop, { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] })).map(
				m => m.name,
			),
		).toEqual(["go-range-int"]);
		// A step-2 loop is not equivalent to range-over-int and must not fire.
		const step2 = "package p\nfunc f(n int) {\n\tfor i := 0; i < n; i += 2 {\n\t\tuse(i)\n\t}\n}";
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot(step2, { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] }),
		).toEqual([]);
	});

	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});
