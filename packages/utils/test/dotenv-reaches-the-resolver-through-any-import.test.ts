import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contracts: a user's `$HOME/.env` reaches the directory resolver no matter which module you imported.
 *
 * THE BUG THIS SUITE EXISTS TO LOCK OUT, which it first reproduced before the fix landed. Every `.env`
 * layer used to be applied by a module-scope block at the bottom of `src/env.ts`, and `env.ts` imports
 * `src/dirs.ts`, so the ONLY thing that applied a user's `.env` was importing `env.ts`. Through
 * `@veyyon/utils` that happened by accident of `export * from "./env"` rather than because anyone asked for
 * it.
 *
 * That made an ordinary-looking cleanup dangerous. Every architecture gate in this repository pushes
 * imports toward the module that OWNS the name, and 632 files in `packages/coding-agent/src` name the bare
 * barrel to get one or two functions out of 74 modules. For a pure helper like `errorMessage` following
 * that rule is strictly better. For `getAgentDir` it silently broke: `dirs.ts` builds `activeProfile` and
 * its `DirResolver` at MODULE LOAD, and what they resolve to is decided by `VEYYON_CODING_AGENT_DIR` and
 * the `XDG_*` variables, so a file that named `@veyyon/utils/dirs` got directories computed before
 * `$HOME/.env` had been read. Measured, in two subprocesses, before the fix: the barrel returned
 * `<home>/from-dotenv` and the leaf returned `<home>/.veyyon/profiles/default/agent`. No error, no warning,
 * a real path to a tree the user never configured, and only in processes whose graph reached no other
 * importer of `env.ts`.
 *
 * WHAT REPLACED IT. Applying a `.env` is two phases, because the four locations are not alike:
 * `$HOME/.env` needs nothing but `os.homedir()`, while `<configRoot>/.env` and `<agentDir>/.env` cannot be
 * found until the resolver exists. So `src/dotenv-home.ts` is phase one and `dirs.ts` imports it;
 * `env.ts` is phase two and applies everything, then calls `refreshDirsFromEnv()`.
 *
 * PHASE ONE IS DELIBERATELY NARROW, and two gates forced it to be. It applies only the keys that decide
 * WHERE a directory is (`@veyyon/utils/dir-env-keys`'s `DIR_LOCATION_ENV_KEYS`: the agent dir, the
 * config-dir name, the `XDG_*` bases) and it does not scrub `Bun.env`. Applying the whole home file that
 * early handed a user's API keys to every subprocess, which broke the eval process entry's contract that a
 * sandboxed evaluator receives no `.env` (`packages/coding-agent/src/eval/__tests__/process-entry-import.test.ts`);
 * scrubbing that early mutated the environment of anything that merely imported the path resolver, which
 * `profiles.test.ts` pins. `VEYYON_PROFILE` is excluded for its own reason: the profile decides where the
 * other `.env` files are, so reading it from one is circular, and it was never honoured from a `.env`. `src/dotenv-parse.ts` owns the parser and the admission rules both phases need,
 * and takes its unreadable-file reporter as a parameter because phase one runs before the logger can exist.
 * `dotenv-precedence.test.ts` pins the ordering the split had to preserve.
 *
 * SUBPROCESSES, not mocks. The behaviour under test IS module load order, so it cannot be observed inside a
 * test file that has already imported both modules: whichever ran first has permanently applied the `.env`
 * for the realm. Each case spawns a fresh `bun` with its own `HOME` and reads what that process printed,
 * importing through ABSOLUTE PATHS into `src/` so there is no question of which module resolution picked.
 *
 * THE FIXTURE PUTS `.env` IN `HOME` AND RUNS FROM SOMEWHERE ELSE, which is load-bearing and was got wrong
 * the first time this was written. Bun reads a `.env` from the CURRENT DIRECTORY by itself, before any
 * module runs, so a fixture whose cwd and home are the same directory shows every import honouring the file
 * and proves nothing about any of them. `$HOME/.env` is the layer `src/dotenv-home.ts` adds, and it is the
 * one that told the two imports apart.
 */

const UTILS_SRC = path.join(import.meta.dir, "..", "src");

let home = "";
let workdir = "";

/** Run `source` as its own process, anchored at the fixture home, and return its stdout, trimmed. */
async function runInFreshProcess(source: string): Promise<string> {
	const script = path.join(workdir, `probe-${Bun.hash(source).toString(36)}.ts`);
	fs.writeFileSync(script, source);
	const proc = Bun.spawn(["bun", "run", script], {
		// NOT `home`: Bun auto-loads a `.env` from the current directory, which would apply the fixture
		// file whatever the import was and make every case below pass for the wrong reason.
		cwd: workdir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			// Deliberately absent: the very variable the fixture `.env` sets. If it were inherited the
			// cases would pass without reading the file at all.
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, `probe process failed:\n${err}`).toBe(0);
	return out.trim();
}

/** What `getAgentDir()` returns in a fresh process that imported exactly one module. */
function agentDirThrough(module: string): Promise<string> {
	return runInFreshProcess(
		[
			`import { getAgentDir } from ${JSON.stringify(path.join(UTILS_SRC, module))};`,
			"console.log(getAgentDir());",
		].join("\n"),
	);
}

beforeAll(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-any-import-"));
	home = path.join(root, "home");
	workdir = path.join(root, "work");
	fs.mkdirSync(home);
	fs.mkdirSync(workdir);
	fs.writeFileSync(
		path.join(home, ".env"),
		// One directory-location key, which phase one may apply, and one ordinary key standing in for an API
		// key, which it must not.
		`VEYYON_CODING_AGENT_DIR=${path.join(home, "from-dotenv")}\nVEYYON_DOTENV_LEAK_PROBE=a-secret-value\n`,
	);
});

afterAll(() => {
	fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("a user's ~/.env reaches the directory resolver", () => {
	/**
	 * The barrel. This is the path that always worked, and it has to keep working: every entry point in the
	 * repository reaches the environment this way today.
	 */
	it("resolves the agent dir from ~/.env when the barrel is imported", async () => {
		expect(await agentDirThrough("index.ts")).toBe(path.join(home, "from-dotenv"));
	});

	/**
	 * THE REGRESSION CASE. The same call, one import away, and the answer must be identical. Before the
	 * split this returned `<home>/.veyyon/profiles/default/agent`, which is why the assertion is an equality
	 * against the configured path and not a comparison between the two imports: the failure mode was two
	 * confident answers, so a case that only checked they AGREED could be satisfied by both being wrong.
	 */
	it("resolves the agent dir from ~/.env when only the dirs leaf is imported", async () => {
		expect(await agentDirThrough("dirs.ts")).toBe(path.join(home, "from-dotenv"));
	});

	/**
	 * And phase one on its own, which is the narrowest possible graph: no resolver, no logger, no barrel. It
	 * has to apply the directory keys by itself, because `dirs.ts` depends on exactly that having happened
	 * before its first line runs.
	 */
	it("applies ~/.env with nothing imported but phase one", async () => {
		const printed = await runInFreshProcess(
			[
				`import ${JSON.stringify(path.join(UTILS_SRC, "dotenv-home.ts"))};`,
				"console.log(Bun.env.VEYYON_CODING_AGENT_DIR ?? '(unset)');",
			].join("\n"),
		);

		expect(printed).toBe(path.join(home, "from-dotenv"));
	});

	/**
	 * The two imports agree, stated separately from the values above. This is the property a reader
	 * actually wants from the fix, and it is worth its own case: it is what stops the next person's owner
	 * repoint from changing behaviour, and it would still fail if someone "fixed" one path by hardcoding the
	 * other's answer.
	 */
	it("gives the same answer through the barrel and through the leaf", async () => {
		const [throughBarrel, throughLeaf] = await Promise.all([agentDirThrough("index.ts"), agentDirThrough("dirs.ts")]);

		expect(throughLeaf).toBe(throughBarrel);
	});
});

describe("the phase split that makes that true", () => {
	/**
	 * `dirs.ts` imports phase one and NOT `env.ts`. Both halves matter: without the first the resolver
	 * caches pre-`.env` paths again, and with the second there is a cycle (`env.ts` imports `dirs.ts`) whose
	 * resolution order would decide whether anything is applied at all.
	 */
	it("dirs imports phase one and not the phase-two module", () => {
		const dirsSource = fs.readFileSync(path.join(UTILS_SRC, "dirs.ts"), "utf-8");

		expect(dirsSource).toMatch(/^import "\.\/dotenv-home";$/m);
		expect(dirsSource).not.toMatch(/^import .* from "\.\/env";$/m);
	});

	/**
	 * AND THE MODULES THAT DELIBERATELY DO NOT, which is the other half of the rule and the reason it is
	 * stated as a list rather than as "every module that reads the environment".
	 *
	 * `startup-marker.ts` and `module-timer.ts` read `VEYYON_DEBUG_STARTUP` and `VEYYON_TIMING`, and both are
	 * diagnostic switches you export for one command rather than settings you keep in a `.env`. More
	 * importantly, `startup-marker.ts` exists to have exactly ONE node builtin as its dependency: its own doc
	 * records that `veyyon --version` must not load a logging stack, which is why the marker was extracted
	 * from `logger.ts` and `cli.ts` in the first place. Adding three modules to it to catch a debug flag from
	 * a `.env` would trade a real constraint for a hypothetical one.
	 *
	 * This case exists so that trade-off is a decision on the record rather than an omission somebody
	 * "fixes" later without knowing what it costs.
	 */
	/**
	 * THE CREDENTIAL CONTRACT, which is why phase one is an allow-list. A key that is not a directory
	 * location must NOT be in the environment after importing the resolver alone: everything phase one sets
	 * is inherited by every subprocess veyyon spawns, and a user's `.env` is where their API keys live.
	 * Importing the barrel is the request for the whole environment, and only then does the key appear.
	 */
	it("does not apply a non-directory key from ~/.env until the barrel is imported", async () => {
		const read = (module: string) =>
			runInFreshProcess(
				[
					`import ${JSON.stringify(path.join(UTILS_SRC, module))};`,
					"console.log(Bun.env.VEYYON_DOTENV_LEAK_PROBE ?? '(unset)');",
				].join("\n"),
			);

		expect(await read("dirs.ts")).toBe("(unset)");
		expect(await read("dotenv-home.ts")).toBe("(unset)");
		expect(await read("index.ts")).toBe("a-secret-value");
	});

	it("keeps the diagnostic switches free of phase one", () => {
		for (const leaf of ["startup-marker.ts", "module-timer.ts"]) {
			expect(fs.readFileSync(path.join(UTILS_SRC, leaf), "utf-8"), leaf).not.toMatch(/dotenv-home/);
		}

		// And the marker really is the one-builtin module its doc claims, which is what makes the exclusion
		// load-bearing rather than laziness.
		const marker = fs.readFileSync(path.join(UTILS_SRC, "startup-marker.ts"), "utf-8");
		const markerImports = [...marker.matchAll(/^import .*from "([^"]+)";$/gm)].map(match => match[1]);
		expect(markerImports).toEqual(["node:fs"]);
	});

	/**
	 * Phase one must not reach the resolver or the logger, which is the constraint that decided the split.
	 * `logger.ts` asks `dirs.ts` where the log directory is, so importing it here would be the same cycle by
	 * a longer route, and a warning that depends on cycle resolution order is a warning that sometimes does
	 * not appear.
	 */
	it("phase one imports neither dirs nor the logger", () => {
		const phaseOne = fs.readFileSync(path.join(UTILS_SRC, "dotenv-home.ts"), "utf-8");

		expect(phaseOne).not.toMatch(/from "\.\/dirs"/);
		expect(phaseOne).not.toMatch(/from "\.\/logger"/);
		expect(phaseOne).toMatch(/from "\.\/dotenv-parse"/);
	});

	/**
	 * The parser has ONE owner, and neither phase carries a copy. Two copies would be worse than the cycle
	 * they would avoid: the phases would disagree about which keys are admissible, and a rejected-in-one key
	 * reads as a `.env` line that works in some processes and not others.
	 */
	it("both phases parse through the shared owner", () => {
		const owner = fs.readFileSync(path.join(UTILS_SRC, "dotenv-parse.ts"), "utf-8");
		const phaseOne = fs.readFileSync(path.join(UTILS_SRC, "dotenv-home.ts"), "utf-8");
		const phaseTwo = fs.readFileSync(path.join(UTILS_SRC, "env.ts"), "utf-8");

		expect(owner).toMatch(/^export function parseEnvFile\(/m);
		expect(phaseOne).toMatch(/parseEnvFile/);
		expect(phaseTwo).toMatch(/parseEnvFile as parseEnvFileWithReporter/);
		expect(phaseTwo).not.toMatch(/^\tconst content = fs\.readFileSync\(filePath/m);
	});

	/**
	 * `refreshDirsFromEnv()` is still called at module scope in phase two. Phase one covers `$HOME/.env`,
	 * but `<agentDir>/.env` and `<configRoot>/.env` can still carry a directory-affecting variable, and
	 * those are read after the resolver was built. Dropping the refresh would leave those two layers
	 * applied to `Bun.env` and invisible to every path.
	 */
	it("phase two still refreshes the resolver", () => {
		const phaseTwo = fs.readFileSync(path.join(UTILS_SRC, "env.ts"), "utf-8");

		expect(phaseTwo).toMatch(/^refreshDirsFromEnv\(\);$/m);
	});
});
