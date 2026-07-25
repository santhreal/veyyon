/**
 * Every eval sandbox admits the same base set of env prefixes, from one owner.
 *
 * A prefix in `allowPrefixes` admits every variable whose name starts with it,
 * so it is the widest opening in the sandbox's environment filter. Three
 * runtimes (py/rb/jl) each need that opening, and each had spelled it out
 * itself — under the SAME name, `DEFAULT_ENV_ALLOW_PREFIXES`, with THREE
 * different values:
 *
 *   py: ["LC_", "XDG_", "VEYYON_"]
 *   jl: ["LC_", "XDG_", "VEYYON_", "JULIA_", "OPENBLAS_", "MKL_"]
 *   rb: ["LC_", "XDG_", "VEYYON_", "GEM_", "BUNDLE", "RBENV_", "RUBY", "CHRUBY_", "ASDF_"]
 *
 * The language-specific tails are deliberate. The shared head was not a
 * decision made three times, it was one decision typed three times, which is
 * the shape that drifts: adding a prefix to the base means editing three files
 * and nothing fails if you edit two. Worse, the shared NAME made the drift
 * invisible to a reader, who would reasonably assume a constant of that name
 * means the same thing in every runtime.
 *
 * So the base lives in `runtime-env.ts` beside `BASE_ENV_ALLOWLIST`, each
 * runtime spreads it and names its own constant for its own language, and
 * these tests hold that arrangement in place: behaviourally (the base actually
 * admits variables in every sandbox) and structurally (nobody retypes it, and
 * no two runtimes share a constant name again).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterEnv as filterJuliaEnv } from "../jl/runtime";
import { filterEnv as filterPythonEnv } from "../py/runtime";
import { filterEnv as filterRubyEnv } from "../rb/runtime";
import { BASE_ENV_ALLOW_PREFIXES } from "../runtime-env";

const EVAL_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The sandboxes that filter a real interpreter environment. */
const RUNTIMES = [
	{ language: "python", file: "py/runtime.ts", filter: filterPythonEnv, constant: "PYTHON_ENV_ALLOW_PREFIXES" },
	{ language: "ruby", file: "rb/runtime.ts", filter: filterRubyEnv, constant: "RUBY_ENV_ALLOW_PREFIXES" },
	{ language: "julia", file: "jl/runtime.ts", filter: filterJuliaEnv, constant: "JULIA_ENV_ALLOW_PREFIXES" },
] as const;

const sourceOf = (file: string): string => readFileSync(join(EVAL_DIR, file), "utf8");

/** Strip comments so an assertion about code never fires on prose describing it. */
const codeOf = (file: string): string =>
	sourceOf(file)
		.split("\n")
		.filter(line => {
			const trimmed = line.trimStart();
			return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
		})
		.join("\n");

describe("the shared eval env allow-prefix base", () => {
	it("is exactly the three prefixes every interpreter needs", () => {
		// Pinned by value, not by length: growing this list widens the sandbox in
		// all three languages at once, which is a decision worth a failing test.
		expect(BASE_ENV_ALLOW_PREFIXES).toEqual(["LC_", "XDG_", "VEYYON_"]);
	});

	for (const { language, filter } of RUNTIMES) {
		it(`admits every base prefix in the ${language} sandbox`, () => {
			// One variable per prefix, each with a value we can identify on the way
			// out, so a filter that dropped one cannot pass by admitting another.
			const env = {
				LC_COLLATE: "en_US.UTF-8",
				XDG_STATE_HOME: "/home/dev/.local/state",
				VEYYON_EVAL_CELL: "cell-7",
			};

			expect(filter(env)).toEqual(env);
		});

		it(`still refuses an unlisted prefix in the ${language} sandbox`, () => {
			// The negative twin: the base is an allowlist, not a pass-through. A
			// filter that returned its input would satisfy the test above.
			expect(filter({ NOT_A_LISTED_PREFIX_VAR: "x", XDG_DATA_DIRS: "/usr/share" })).toEqual({
				XDG_DATA_DIRS: "/usr/share",
			});
		});

		it(`still refuses a secret-shaped name under a base prefix in the ${language} sandbox`, () => {
			// `VEYYON_` is broad on purpose, which is only safe because the denylist
			// and the secret-name pattern outrank it. Sharing the base must not have
			// widened that hole.
			const filtered = filter({
				VEYYON_API_KEY: "sk-live-should-never-reach-a-cell",
				VEYYON_TOKEN: "tok-should-never-reach-a-cell",
				VEYYON_EVAL_CELL: "cell-7",
			});

			expect(filtered).toEqual({ VEYYON_EVAL_CELL: "cell-7" });
		});
	}

	it("gives ruby and julia their language prefixes on top of the base", () => {
		// The tails are the part that legitimately differs; assert they survived
		// the hoist rather than being flattened into the shared list.
		expect(filterRubyEnv({ GEM_HOME: "/home/dev/.gem", BUNDLE_PATH: "vendor/bundle" })).toEqual({
			GEM_HOME: "/home/dev/.gem",
			BUNDLE_PATH: "vendor/bundle",
		});
		expect(filterJuliaEnv({ JULIA_DEPOT_PATH: "/home/dev/.julia", MKL_NUM_THREADS: "4" })).toEqual({
			JULIA_DEPOT_PATH: "/home/dev/.julia",
			MKL_NUM_THREADS: "4",
		});
	});

	it("does not leak one language's prefixes into another's sandbox", () => {
		// The reason each runtime keeps its own constant: a Ruby cell has no
		// business reading Julia's depot path, and vice versa.
		expect(filterPythonEnv({ GEM_HOME: "/home/dev/.gem", JULIA_DEPOT_PATH: "/home/dev/.julia" })).toEqual({});
		expect(filterRubyEnv({ JULIA_DEPOT_PATH: "/home/dev/.julia" })).toEqual({});
		expect(filterJuliaEnv({ GEM_HOME: "/home/dev/.gem" })).toEqual({});
	});
});

describe("the shared base has exactly one definition", () => {
	for (const { language, file, constant } of RUNTIMES) {
		it(`${language} spreads the shared base instead of retyping it`, () => {
			expect(codeOf(file)).toContain(`${constant} = [...BASE_ENV_ALLOW_PREFIXES`);
		});

		it(`${language} does not retype the base prefixes as literals`, () => {
			// The exact literal that was pasted into all three files.
			expect(codeOf(file)).not.toContain('"LC_", "XDG_", "VEYYON_"');
		});

		it(`${language} names its constant for its own language`, () => {
			// The old shared name is what made three different values look like one
			// thing. No runtime may reintroduce it.
			expect(codeOf(file)).not.toContain("DEFAULT_ENV_ALLOW_PREFIXES");
		});
	}

	it("gives no two runtimes the same constant name", () => {
		const names = RUNTIMES.map(r => r.constant);

		expect(new Set(names).size).toBe(names.length);
	});
});
