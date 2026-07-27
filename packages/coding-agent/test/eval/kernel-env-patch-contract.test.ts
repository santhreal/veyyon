/**
 * Every language kernel honours the same environment-patch contract.
 *
 * WHY THIS SUITE EXISTS (FINDING-DUPLICATE-EXPORTED-TYPE-NAMES-ACROSS-PACKAGES).
 * `KernelExecuteOptions` was declared THREE times -- once in `eval/kernel-base.ts`
 * and again, separately, in the Ruby and Julia kernels -- and the copies had drifted
 * in exactly the field where drift is invisible. The base documents `env` as a
 * PATCH: a string SETS the variable, `null` CLEARS it, and `undefined` leaves it
 * alone. Ruby's copy typed it `Record<string, string | null>`, so it could not
 * express "leave this one alone"; Julia's typed it `Record<string, string |
 * undefined>`, so it could not express "clear this one". Neither declaration was
 * wrong on its own terms, and that is the problem: a caller who read one learned the
 * wrong contract for the other two.
 *
 * The drift was not theoretical. Both kernels built their start-up preamble with a
 * `value !== undefined` test, so a `null` fell straight through:
 *
 *  - Ruby emitted `ENV["k"] = null`, and `null` is not a Ruby literal. The preamble
 *    raised a NameError and took the user's code down with it.
 *  - Julia reached `Buffer.from(null)` and threw a TypeError while BUILDING the
 *    script, so the request failed before Julia saw a byte of it.
 *
 * Ruby's per-execution path was already correct (`runner.rb` maps `nil` to
 * `ENV.delete`), which is what made this so easy to miss: the same kernel honoured
 * the contract in one place and crashed on it in another.
 *
 * Asserted on the emitted BYTES rather than through a live kernel. The contract is
 * about what text gets generated, and a live kernel needs the interpreter installed,
 * so a behavioural test here would just be skipped on the machines that most need it.
 */
import { describe, expect, it } from "bun:test";
import { buildInitScript as buildJuliaInitScript } from "@veyyon/coding-agent/eval/jl/kernel";
import type { KernelEnvPatch } from "@veyyon/coding-agent/eval/kernel-base";
import { buildInitScript as buildRubyInitScript } from "@veyyon/coding-agent/eval/rb/kernel";

/** Decode Julia's base64-wrapped literals so assertions read as the text they carry. */
function decodeJuliaLiterals(script: string): string {
	return script.replace(/String\(Base64\.base64decode\("([^"]*)"\)\)/g, (_, encoded: string) =>
		JSON.stringify(Buffer.from(encoded, "base64").toString("utf8")),
	);
}

describe("the Ruby kernel start-up preamble", () => {
	/** A plain string sets the variable, which is the case that always worked. */
	it("sets a variable from a string value", () => {
		const script = buildRubyInitScript("/work", { API_TOKEN: "abc123" });

		expect(script).toContain('ENV["API_TOKEN"] = "abc123"');
		expect(script).not.toContain("ENV.delete");
	});

	/**
	 * The regression. Before the unification this emitted `ENV["STALE"] = null`, which
	 * is a NameError in Ruby, so a single cleared variable broke the entire preamble --
	 * the `Dir.chdir`, the `$LOAD_PATH` setup, and every other variable in the same
	 * patch went with it.
	 */
	it("clears a variable on null instead of emitting an invalid literal", () => {
		const script = buildRubyInitScript("/work", { STALE: null });

		expect(script).toContain('ENV.delete("STALE")');
		expect(script).not.toContain("null");
		expect(script).not.toContain('ENV["STALE"] =');
	});

	/** `undefined` means "leave it alone": no assignment, no delete, no mention. */
	it("emits nothing at all for undefined", () => {
		const script = buildRubyInitScript("/work", { UNTOUCHED: undefined });

		expect(script).not.toContain("UNTOUCHED");
	});

	/**
	 * All three in one patch, which is the case Ruby's old `Record<string, string |
	 * null>` could not even express. Order follows the object, so the exact lines are
	 * pinned rather than checked one at a time.
	 */
	it("mixes set, clear, and leave-alone in a single patch", () => {
		const patch: KernelEnvPatch = { SET_ME: "yes", CLEAR_ME: null, SKIP_ME: undefined };
		const script = buildRubyInitScript("/work", patch);

		expect(script.split("\n").filter(line => line.startsWith("ENV"))).toEqual([
			'ENV["SET_ME"] = "yes"',
			'ENV.delete("CLEAR_ME")',
		]);
	});

	/** Keys and values are JSON-quoted, so a quote or backslash cannot break out. */
	it("escapes a hostile key and value rather than emitting them raw", () => {
		const script = buildRubyInitScript("/work", { 'A"B': 'v"\\x' });

		expect(script).toContain('ENV["A\\"B"] = "v\\"\\\\x"');
	});

	/** The preamble still does its other job: chdir first, then the load path. */
	it("keeps the working-directory setup around the variables", () => {
		const script = buildRubyInitScript("/proj", { X: "1" });
		const lines = script.split("\n");

		expect(lines[0]).toBe('__veyyon_init_cwd = "/proj"');
		expect(lines[1]).toBe("Dir.chdir(__veyyon_init_cwd) rescue nil");
		expect(lines.at(-1)).toBe("$LOAD_PATH.unshift(__veyyon_init_cwd)");
	});
});

describe("the Julia kernel start-up preamble", () => {
	/** A plain string sets the variable, base64-wrapped so no Julia escaping is needed. */
	it("sets a variable from a string value", () => {
		const script = decodeJuliaLiterals(buildJuliaInitScript("/work", { API_TOKEN: "abc123" }));

		expect(script).toContain('ENV["API_TOKEN"] = "abc123"');
		expect(script).not.toContain("delete!(ENV");
	});

	/**
	 * The regression, and Julia's was the worse of the two: `Buffer.from(null)` throws
	 * a TypeError while the script is still being BUILT, so the request never reached
	 * the kernel and the failure surfaced as a supervisor crash rather than as a
	 * kernel error the user could read.
	 */
	it("clears a variable on null instead of throwing while building the script", () => {
		const script = decodeJuliaLiterals(buildJuliaInitScript("/work", { STALE: null }));

		expect(script).toContain('delete!(ENV, "STALE")');
		expect(script).not.toContain('ENV["STALE"] =');
	});

	/** `undefined` means "leave it alone", encoded form included. */
	it("emits nothing at all for undefined", () => {
		const raw = buildJuliaInitScript("/work", { UNTOUCHED: undefined });

		expect(decodeJuliaLiterals(raw)).not.toContain("UNTOUCHED");
		expect(raw).not.toContain(Buffer.from("UNTOUCHED").toString("base64"));
	});

	/** All three in one patch, the case Julia's old type could not express either. */
	it("mixes set, clear, and leave-alone in a single patch", () => {
		const patch: KernelEnvPatch = { SET_ME: "yes", CLEAR_ME: null, SKIP_ME: undefined };
		const script = decodeJuliaLiterals(buildJuliaInitScript("/work", patch));

		expect(script.split("\n").filter(line => line.includes("ENV"))).toEqual([
			'ENV["SET_ME"] = "yes"',
			'delete!(ENV, "CLEAR_ME")',
		]);
	});

	/** The preamble still does its other job: cd first, then LOAD_PATH. */
	it("keeps the working-directory setup around the variables", () => {
		const lines = decodeJuliaLiterals(buildJuliaInitScript("/proj", { X: "1" })).split("\n");

		expect(lines[0]).toBe('__veyyon_init_cwd = "/proj"');
		expect(lines[1]).toBe("try cd(__veyyon_init_cwd) catch; end");
		expect(lines.at(-1)).toContain("pushfirst!(LOAD_PATH, __veyyon_init_cwd)");
	});
});

describe("the Julia execute-request wire format", () => {
	/**
	 * A per-execution patch travels as `key_b64:value_b64` pairs, and a CLEAR needs a
	 * representation the old format had none for. The key is prefixed with `!`, which
	 * is outside the base64 alphabet and so can never be part of an encoded key.
	 *
	 * Asserted against `runner.jl` as well as the encoder, because a wire format with
	 * only one end implemented is the failure this pair is meant to prevent: Ruby's
	 * `runner.rb` already honoured `nil` while its own preamble builder did not, and
	 * nothing noticed for exactly that reason.
	 */
	it("marks a cleared key with a base64-illegal prefix that the runner decodes", async () => {
		const runner = await Bun.file(new URL("../../src/eval/jl/runner.jl", import.meta.url).pathname).text();

		expect(runner).toContain('clear = startswith(k_b64, "!")');
		expect(runner).toContain("delete!(ENV, k)");
		// `!` is not one of A-Z a-z 0-9 + / =, so no encoded key can begin with it.
		expect("!").not.toMatch(/[A-Za-z0-9+/=]/);
	});
});
