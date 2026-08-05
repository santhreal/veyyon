/**
 * A test may not reach outside its sandbox, and this is what fails when one does.
 *
 * ## The rule
 *
 * No test file under `packages/*​/test/**` may:
 *
 *  1. WRITE to a path under the developer's real home or real config root,
 *  2. spawn the INSTALLED `veyyon` binary (`~/.local/bin/veyyon`, or `veyyon`
 *     resolved from `PATH`), including through a variable holding its name,
 *  3. spawn a command it cannot even READ: a target that is a bare variable,
 *     parameter or property with no literal anywhere in it, so nothing in the
 *     source says what runs. That fails closed, because the answer "we could not
 *     tell" is not the answer "it is safe",
 *  4. claim isolation it does not have, by assigning `process.env.HOME` with no
 *     `os.homedir` spy and no config-root redirect in the same file,
 *  5. NAME the real home at all -- by importing the tripwire's `__tripwire`, by
 *     calling `enterRealHome`, or by reading `VEYYON_TEST_REAL_CONFIG_ROOT` -- unless
 *     it is on the allowlist below with a reason.
 *
 * ## Why it exists
 *
 * The write case is the severe one, and it is not theoretical damage: a test that
 * writes into `~/.veyyon` can destroy a live credential. One suite already did
 * exactly that, putting three rows into the developer's real credential store while
 * every assertion in it passed. A setting, a profile, a session, an OAuth refresh
 * token: all of it lives in one directory, and a test run is the last thing that
 * should be able to edit it. Spawning the INSTALLED binary is the same failure with
 * a longer fuse, because a child process is outside every in-process guard the suite
 * has, runs the operator's build rather than this working tree, and reads their real
 * credentials to do it. The unreadable-target case exists because that longer fuse has
 * no runtime backstop of any kind: a WRITE aimed at the real config root is refused by
 * the tripwire however the path was spelled, but a spawn is a new process and nothing
 * in it is guarded, so the only chance to stop it is here, in the reading.
 *
 * The fake-isolation case is the one that kept coming back, and it is the reason this
 * gate is static rather than a runtime probe. Under Bun, `os.homedir()` is resolved once at
 * process start and does NOT follow a later `process.env.HOME` assignment. So a suite
 * can set `HOME` to a temp directory, write its fixtures there, assert against paths
 * it built by hand under that same directory, pass, and read the developer's real
 * `~/.veyyon` from beginning to end. Nothing fails. Nothing looks wrong in review. Ten
 * suites were in that state when this gate was written, and every one of them had been
 * read by someone who concluded it was isolated.
 *
 * The real-home-reference case is newer and it is the one this gate was missing. Every test process
 * now starts with `os.homedir()` and `HOME` pointing at an empty per-process sandbox
 * (`packages/utils/test/helpers/sandbox-home.ts`, loaded by the tripwire preload). Before
 * that existed, a report-only fs probe run per test file measured 2,829 of 4,609 files
 * READING the operator's real home, 2,814 of them reading `$HOME/.env` -- their API
 * keys -- because `packages/utils/src/env.ts` parses four `.env` layers at module
 * scope and everything imports the barrel. None of the three rules above could see a
 * single one of those, because none of them wrote anything down. With the redirect in
 * place the measurement is 2 files, both of them deliberate, and that rule is what keeps
 * that number countable: the only ways left to reach the real home are named, and each
 * user of one has to be listed.
 *
 * ## Why static analysis, not a runtime check
 *
 * A runtime probe (through the leak tracer's preload, say) can only see the paths a
 * test actually touched on the run that happened. It cannot see a violation inside a
 * skipped case, a platform-gated branch, or an error path, and it cannot see the
 * fake-isolation case AT ALL, because its entire signature is that nothing observably
 * misbehaves. Reading the sources sees all five, needs no test process, and finishes
 * in well under a second on 4,400 files. The runtime half of this protection already
 * exists and is complementary, not a substitute: `packages/utils/test/helpers/
 * real-data-tripwire.ts` is preloaded into every test process, redirects `HOME` before
 * any test module loads, and refuses the writes this gate refuses to let anyone WRITE
 * DOWN. The one runtime assertion that does live here guards that preload itself; see
 * "the home redirect" below.
 *
 * ## Adding an exception
 *
 * Put it in `ALLOWLIST` with a reason that says why the violation is correct. An entry
 * with an empty reason fails this suite, on purpose: an unexplained exception is how a
 * gate turns into a list nobody can prune.
 */
import { describe, expect, it } from "bun:test";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEMP_HOME } from "../packages/utils/test/helpers/sandbox-home";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Never walked. `fixtures` holds deliberately broken inputs, not tests. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "fixtures", "dist", "target", "repo-cache", ".git"]);

/** The six things this gate refuses. */
export type Rule =
	| "real-home-write"
	| "installed-binary-spawn"
	| "unresolved-spawn-target"
	| "fake-home-isolation"
	| "real-home-scan"
	| "real-home-reference";

export interface Violation {
	file: string;
	line: number;
	rule: Rule;
	/** The offending source, collapsed to one line, so the failure is readable without opening the file. */
	evidence: string;
}

/**
 * Known exceptions, each with the reason the violation is CORRECT.
 *
 * A file listed here is exempt from the NAMED rule and nothing else, so an allowlisted
 * suite that later starts spawning the installed binary still fails.
 *
 * This list is for a suite whose violation is the right thing to do, not a parking space
 * for one that is merely inconvenient to fix. The staleness check below deletes the excuse
 * the moment a listed file stops violating, so an entry cannot outlive its reason. There
 * was briefly a second, weaker tier here for a real defect owned by another lane; that lane
 * fixed the suite instead, which is the outcome the tier would have made easy to avoid, so
 * the tier is gone.
 */
export interface AllowlistEntry {
	file: string;
	rule: Rule;
	reason: string;
}

export const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
	{
		file: "packages/utils/test/destructive-guard.test.ts",
		rule: "fake-home-isolation",
		reason:
			"It is the suite that PROVES the trap. Its whole subject is that a mid-process `process.env.HOME` assignment does not move `os.homedir()`, so it deliberately assigns HOME without a spy and then asserts `os.homedir()` disagrees with it. Installing the spy this gate normally demands would delete the behaviour under test. It reaches no real path either way: every value it assigns is a string handed to a pure predicate, never opened.",
	},
	{
		file: "packages/utils/test/real-data-tripwire.test.ts",
		rule: "real-home-reference",
		reason:
			"It is the tripwire's own suite, and the tripwire's subject IS the real config root. It has to aim a write at the real `~/.veyyon` and require the refusal, so pointing it at a temp path would make every assertion in it vacuous. Measured with the fs probe: it reaches two real paths, an `existsSync` on `~/.veyyon/__tripwire_probe__` that must report false and an `existsSync` on `~/.veyyon` itself, plus one `symlinkSync` the tripwire refuses. It creates nothing, which its last case asserts.",
	},
	{
		file: "packages/ai/test/real-credential-store-unreachable.test.ts",
		rule: "real-home-reference",
		reason:
			"It is the permanent replay of the incident: it opens the REAL `~/.veyyon/shared-auth/agent.db` through the credential store and requires the tripwire to refuse. A temp path would prove nothing, because the thing under test is that the real store is unreachable. Measured with the fs probe: one `stat` of `~/.veyyon/shared-auth`, no write, no row.",
	},
	{
		file: "packages/coding-agent/test/tools/path-length-limits.test.ts",
		rule: "real-home-reference",
		reason:
			"It imports `__tripwire` only for the two PURE containment predicates, `resolveForContainment` and `isInsideResolved`, and calls them on paths it built under its own tracked temp directories. It names no real path and the fs probe measured zero real-home access from it. The entry exists because the import is the honest trigger for this rule and an import of the tripwire's internals is worth one line of justification.",
	},
	// The seven below are all `unresolved-spawn-target`: a spawn whose command argument is a
	// variable, a parameter or a property, so no reader of the source alone can say what it
	// runs. Each reason therefore has to answer the one question the analyzer could not, which
	// is what the target actually holds at runtime. Two of them genuinely execute a file NAMED
	// `veyyon`, which is exactly why the rule stops here and asks rather than guessing.
	{
		file: "packages/coding-agent/test/update-while-running.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			"`layout.target` is `path.join(await fs.mkdtemp(...), \"veyyon\")`, a five-line `/bin/sh` script the test writes itself and then updates while it runs. It is a file named veyyon and it is deliberately not the install: the suite's whole subject is replacing the binary underneath a live process, which cannot be staged against the operator's own. Nothing here resolves a name through PATH.",
	},
	{
		file: "packages/coding-agent/test/cli/update-windows-running-binary.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			'`target` is `path.join(await fs.mkdtemp(...), "veyyon.exe")`, a copy of `process.execPath`, so the child is Bun under another name running an inline script. The suite is `describe.skipIf(process.platform !== "win32")` and spawns hermetically through `hermeticSpawnEnv()`, so even on Windows it cannot reach a real config tree.',
	},
	{
		file: "packages/coding-agent/test/plugin-install-git.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			'`command` is the `string[]` parameter of the file\'s own `runCommand` helper, and every one of its call sites passes a literal argv beginning with `"git"`, inside a temp source directory. The target is unreadable at the spawn site only because the helper exists; it is a git invocation at every caller.',
	},
	{
		file: "packages/coding-agent/test/shell-snapshot.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			"`realBash` is `REAL_BASH`, which is `Bun.env.SHELL` when it names bash and otherwise the literal `/bin/bash`, guarded by an `existsSync` that returns early. It runs the operator's bash with `--noprofile --norc` against a snapshot file the test wrote, which is the point: a snapshot of a login shell cannot be taken with a fake shell.",
	},
	{
		file: "packages/coding-agent/test/tools.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			'`mkfifoPath` is the result of `$which("mkfifo")` and the test returns early when it is absent. It creates a FIFO under the test\'s own temp directory so the special-file path can be exercised on a real named pipe, which no stub can provide.',
	},
	{
		file: "packages/coding-agent/test/tools/browser-tab-evaluate.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			"`executable` is whatever `ensureChromiumExecutable()` resolved, and the spawn is a `--version` probe whose only purpose is deciding whether to skip: CI hosts hold the downloaded Chromium but lack the system libraries to exec it. A probe that must ask the real binary cannot be written against a literal path.",
	},
	{
		file: "packages/coding-agent/test/core/python-runner-integration.test.ts",
		rule: "unresolved-spawn-target",
		reason:
			'`runtime.pythonPath` is the interpreter the setup path discovered, either the system python or the managed environment\'s. The spawn is `-c "import matplotlib"`, a capability probe against that specific interpreter, which is the one thing a hardcoded path would answer wrongly.',
	},
];

/** Mutating `node:fs` entry points, by the name that appears at the call site. */
const MUTATORS = [
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"mkdir",
	"mkdirSync",
	"mkdtemp",
	"mkdtempSync",
	"rm",
	"rmSync",
	"rmdir",
	"rmdirSync",
	"unlink",
	"unlinkSync",
	"copyFile",
	"copyFileSync",
	"cp",
	"cpSync",
	"rename",
	"renameSync",
	"symlink",
	"symlinkSync",
	"link",
	"linkSync",
	"truncate",
	"truncateSync",
	"chmod",
	"chmodSync",
	"createWriteStream",
] as const;

const MUTATOR_CALL = new RegExp(`(?:\\bBun\\.write|\\b(?:${MUTATORS.join("|")}))\\s*\\(`, "g");

/**
 * Call heads that start a child process.
 *
 * Matched only as a BARE call or through an object that is provably `node:child_process`
 * (or `Bun`). The previous pattern matched any `spawn(`/`exec(` whatever preceded it, so
 * `registry.spawn(session, ...)` and `SOME_REGEX.exec(text)` were scanned as process
 * spawns: harmless while the only question asked was "does the argument text name the
 * installed binary", and 17 false positives the moment an unresolvable target became a
 * violation. Namespace aliases are collected per file rather than assumed, so
 * `import * as cp from "node:child_process"; cp.spawnSync(...)` stays covered.
 */
const SPAWN_HEADS = "spawnSync|spawn|execFileSync|execFile|execSync|exec";
/** Cheap pre-test: no spawn-shaped token at all means none of the passes below are worth running. */
const SPAWNS_SOMETHING = new RegExp(`(?:${SPAWN_HEADS})\\s*\\(`);
/** `function spawn(` defines a helper; only a call runs anything. */
const DECLARATION_KEYWORD = /\bfunction\s+$/;
/** `args: {`, `path?: string`: a typed parameter list, which no argument list ever is. */
const TYPED_PARAMETER = /^[A-Za-z_$][\w$]*\s*\??\s*:/;
const CHILD_PROCESS_NAMESPACE =
	/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'`](?:node:)?child_process["'`]|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'`](?:node:)?child_process["'`]\s*\)/g;

function spawnCallRegex(source: string): RegExp {
	const objects = ["Bun"];
	CHILD_PROCESS_NAMESPACE.lastIndex = 0;
	for (let match = CHILD_PROCESS_NAMESPACE.exec(source); match; match = CHILD_PROCESS_NAMESPACE.exec(source)) {
		const name = match[1] ?? match[2];
		if (name) objects.push(name);
	}
	return new RegExp(String.raw`(?:(?<=\b(?:${objects.join("|")})\.)|(?<![.\w$]))(?:${SPAWN_HEADS})\s*\(`, "g");
}

/**
 * Every `const NAME = "literal"` in the file, so a command spelled through a variable can
 * still be read. `const bin = "veyyon"; spawnSync(bin, ["auth", "list"])` scanned clean
 * before this existed, and unlike a redirected WRITE, which the real-data tripwire refuses
 * at runtime whatever the path was called, a spawn of the installed binary has no runtime
 * backstop at all: it reaches the operator's real profile, credentials and model spend on
 * the first call and nothing reports it.
 *
 * A name bound more than once resolves to nothing rather than to its first value, and an
 * interpolated template is not a constant. Both then fall through to the unresolvable
 * case, which is a violation, so being unable to read a name never reads as safe.
 */
const STRING_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const AMBIGUOUS = Symbol("bound more than once");

function stringBindings(source: string): Map<string, string | typeof AMBIGUOUS> {
	const bindings = new Map<string, string | typeof AMBIGUOUS>();
	STRING_BINDING.lastIndex = 0;
	for (let match = STRING_BINDING.exec(source); match; match = STRING_BINDING.exec(source)) {
		const name = match[1] as string;
		const value = match[3] as string;
		bindings.set(name, bindings.has(name) || value.includes("${") ? AMBIGUOUS : value);
	}
	return bindings;
}

/** Index just past the string literal opening at `start`. */
function endOfString(source: string, start: number): number {
	const quote = source[start];
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === quote) return i;
		i++;
	}
	return source.length;
}

/**
 * The first argument in `text`, which begins just past an opening delimiter.
 *
 * Nesting-aware rather than split on the first comma, because the argument that matters
 * is routinely a call: `path.join(distDir, "veyyon")` cut at the first comma reads as
 * `path.join(distDir`, which loses the very literal that says what is being run.
 */
function firstArgument(text: string): string {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === '"' || c === "'" || c === "`") {
			i = endOfString(text, i);
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) return text.slice(0, i);
			depth--;
		} else if (c === "," && depth === 0) return text.slice(0, i);
	}
	return text;
}

/**
 * The COMMAND argument of a spawn call: the first element of an argv array, the head of a
 * `{ cmd: [...] }` object, or the first positional argument.
 */
function commandTargetOf(text: string): string {
	const inner = text.replace(/^\(/, "").trim();
	if (inner.startsWith("[")) return firstArgument(inner.slice(1)).trim();
	const objectCmd = /^\{\s*cmd\s*:\s*\[/.exec(inner);
	if (objectCmd) return firstArgument(inner.slice((objectCmd[0] as string).length)).trim();
	return firstArgument(inner).trim();
}

/**
 * Offsets that sit inside a string or template literal, so a call head QUOTED as source
 * text is not read as a call. Several suites build an extension's source in an array of
 * strings, and one of them contains the line `async exec(command, cwd, options) {`: a
 * fail-closed spawn rule reading that as an unreadable spawn target would report a file
 * that spawns nothing at all.
 */
function stringMask(source: string): Uint8Array {
	const mask = new Uint8Array(source.length);
	for (let i = 0; i < source.length; i++) {
		const c = source[i] as string;
		if (c !== '"' && c !== "'" && c !== "`") continue;
		const end = endOfString(source, i);
		mask.fill(1, i, Math.min(end + 1, source.length));
		i = end;
	}
	return mask;
}

/**
 * The runner's own executable. `process.execPath` is Bun, which is what a test spawns to
 * run this repository's CLI entry from source, and it can never be the installed binary.
 */
const RUNNER_EXECUTABLE = /^process\.(?:execPath|argv\[\s*0\s*\])$/;

/**
 * An argument that names the real home.
 *
 * `homedir()` counts only in a file with no isolation (see `isolates`), because in an
 * isolated file it IS the temp home and flagging it would punish the correct pattern. A
 * hardcoded `~/...` or `/home/<user>/...` literal counts everywhere: no spy moves a
 * string that was already absolute when it was typed.
 */
const HOMEDIR_CALL = /\bos\.homedir\(\)|\bhomedir\(\)|\bos\.userInfo\(\)\.homedir/;
const HARDCODED_HOME_LITERAL = /["'`](?:~\/|\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/)/;

/**
 * The INSTALLED binary, as opposed to this repository's own artifact.
 *
 * Two shapes, because they need different amounts of context.
 *
 * An explicit install path (`~/.local/bin/veyyon`, `/usr/local/bin/veyyon`) names the
 * installed binary wherever it appears in the arguments, so it is matched anywhere in
 * the call.
 *
 * A bare `"veyyon"` only means "whatever is first on PATH" when it sits in COMMAND
 * position: the first thing passed to the spawner, the first element of its argv array, or
 * the head of a `{ cmd: [...] }` options object. Matched loosely it would also hit
 * `path.join(distDir, "veyyon")`, which is this tree's own build and exactly what a test
 * SHOULD run, so the position is part of the rule rather than an afterthought.
 *
 * What follows the name is a character class rather than a closing quote, because
 * `execSync("veyyon --version")` passes the whole command line as ONE string and a
 * quote-terminated match walked straight past it. `veyyon-something` is left alone: a
 * hyphen is not in the class.
 */
const INSTALLED_BINARY_PATH =
	/["'`](?:~|\$HOME|\/home\/[^"'`/]+|\/Users\/[^"'`/]+)?\/?(?:\.local\/bin\/|\.bun\/bin\/|usr\/local\/bin\/)veyyon["'`]/;
const VEYYON_IN_COMMAND_POSITION = /^\(\s*(?:\{\s*cmd\s*:\s*)?\[?\s*["'`]veyyon(?:["'`]|\s)/;
const WHICH_VEYYON = /(?:Bun\.which|which)\s*\(\s*["'`]veyyon["'`]\s*\)/;

/**
 * `Bun.$` and the bare `$` tag run a command without going through any of the call heads
 * above, so the spawn scan cannot see them at all. `` $`veyyon auth list` `` is the same
 * violation as `spawnSync("veyyon", ...)` with different punctuation.
 */
const VEYYON_IN_SHELL_TEMPLATE = /(?:Bun\.\$|(?<![\w.$])\$)\s*`\s*veyyon(?:[\s`]|\\n)/g;

/**
 * Two different kinds of isolation, kept apart because they protect different things.
 *
 * MOVES_HOMEDIR is the strong one: after it, `os.homedir()` itself answers a temp path, so
 * EVERY home-relative path in the process moves, including the foreign trees veyyon does not
 * own (`~/.claude/skills`, `~/.codex/hooks`, `~/.config/fish/completions`).
 *
 * REDIRECTS_CONFIG_ROOT is the weaker one: `enterIsolatedConfigRoot` and friends move
 * veyyon's own config root and leave `os.homedir()` reporting the real home, ON PURPOSE
 * (read its header). That is enough to make a `process.env.HOME` assignment honest about
 * what it covers, and it is NOT enough to make `path.join(os.homedir(), …)` safe. Treating
 * the two as interchangeable is how a write into the developer's real home would pass this
 * gate while looking isolated in review, which is the exact defect shape the gate is for.
 * No file in the tree relies on the conflation today, so separating them changes no verdict
 * and closes the hole before someone lands in it.
 */
const MOVES_HOMEDIR =
	/spyOn\(\s*\w+\s*,\s*["'`]homedir["'`]\s*\)|mock\.module\(\s*["'`]node:os["'`]|enterTempHome|useTempHome|useContextScopeFixture/;
const CONFIG_ROOT_HELPERS =
	/enterIsolatedConfigRoot|useIsolatedConfigRoot|withIsolatedConfigRoot|hermeticSpawnEnv|captureDirOverrides/;

/**
 * Every remaining way a test can name the operator's real home, now that the preload
 * redirects `os.homedir()` and `HOME` before any test module loads.
 *
 * There are exactly three, and that is the point of listing them: an in-process test can
 * no longer arrive at real data by accident, so anything that gets there did so by asking
 * for one of these BY NAME. `__tripwire` exposes `FORBIDDEN`, the real config root captured
 * before the redirect. `enterRealHome` puts the honest `os.homedir()` back. The env var is
 * where the runner writes the pre-redirect root. A suite using one is not necessarily
 * wrong -- the tripwire's own tests could not exist otherwise -- but it must be listed, so
 * "how many suites can still reach real data" has an answer someone can read in one place.
 */
const REAL_HOME_REFERENCE = /\b__tripwire\b|\benterRealHome\s*\(|\bVEYYON_(?:TEST_REAL_CONFIG_ROOT|ALLOW_REAL_HOME)\b/;

/**
 * A config-root redirect counts only when the variable is SET.
 *
 * The name has to be assigned: `process.env.VEYYON_CONFIG_DIR = …`, `childEnv.VEYYON_CONFIG_DIR = …`,
 * `process.env["VEYYON_CONFIG_DIR"] = …`, or a `VEYYON_CONFIG_DIR:` key in a spawn env object.
 * Merely CONTAINING the string used to be enough, which meant a suite that only read the
 * variable back, or deleted it from a child environment, or asserted on an error message
 * that quotes it, was recorded as isolated and had its fake HOME waved through. Thirty-nine
 * files reach the string without redirecting anything.
 */
const REDIRECTS_CONFIG_DIR = /VEYYON_CONFIG_DIR(?:["'`]\s*\])?\s*[=:](?!=)/;

const ASSIGNS_HOME = /(?:process\.env\.HOME|process\.env\[\s*["'`]HOME["'`]\s*\])\s*=(?!=)/;

/** True when `os.homedir()` itself answers a temp path in this file. */
export function movesHomedir(source: string): boolean {
	return MOVES_HOMEDIR.test(source);
}

/** True when the file moves the config root, by either mechanism. */
export function isolates(source: string): boolean {
	return MOVES_HOMEDIR.test(source) || CONFIG_ROOT_HELPERS.test(source) || REDIRECTS_CONFIG_DIR.test(source);
}

/** 1-based line number of a source offset. */
function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (source.charCodeAt(i) === 10) line++;
	}
	return line;
}

/**
 * The text of the parenthesised call whose `(` sits at `open`.
 *
 * Balanced rather than line-based because the arguments this looks for are routinely
 * spread over several lines, and a per-line scan would miss every one of them. Bounded
 * so a stray unbalanced paren cannot walk the rest of the file.
 */
function callText(source: string, open: number): string {
	let depth = 0;
	const limit = Math.min(source.length, open + 4000);
	for (let i = open; i < limit; i++) {
		const c = source[i];
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	return source.slice(open, limit);
}

/**
 * Blank out comments, keeping every byte position and newline.
 *
 * A doc comment EXPLAINING one of these mistakes is not one of these mistakes, and the
 * suites that already document the traps are full of the exact phrases matched below:
 * one file's header describes the bug where the updater ran `which("veyyon")`, which
 * tripped this gate before comments were stripped. Punishing the file that warns about a
 * defect is a fast way to get the warnings deleted.
 *
 * Replacing rather than removing keeps line numbers and offsets true, so a reported line
 * still points at the real one. String and template literals are walked so that a `//`
 * inside a URL does not swallow the rest of the line.
 */
export function withoutComments(source: string): string {
	const out = source.split("");
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") out[i++] = " ";
			continue;
		}
		if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end < 0 ? source.length : end + 2;
			for (; i < stop; i++) {
				if (source[i] !== "\n") out[i] = " ";
			}
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			i++;
			while (i < source.length) {
				if (source[i] === "\\") {
					i += 2;
					continue;
				}
				if (source[i] === c) break;
				i++;
			}
			i++;
			continue;
		}
		i++;
	}
	return out.join("");
}

/** One line of the offending call, for the failure message. */
function evidenceOf(text: string): string {
	return text.replace(/\s+/g, " ").slice(0, 140);
}

/**
 * Production entry points that read the OPERATOR'S REAL MACHINE and accept no override.
 *
 * This registry exists because the other three rules all look at what a test WRITES DOWN, and
 * the worst case found in this tree wrote nothing suspicious at all. `setup-wizard-viewport`
 * drove `await scene.shouldRun?.(ctx)` over the REAL scenes. `importSetupScene.shouldRun`
 * calls `scanForeignConfig()` with no home argument, `loadCapability` fills that in from
 * `os.homedir()`, and one call reads 39 paths in the developer's home, `~/.env` among them,
 * and hands back their personal Claude skills as fixture data. Nothing in the test source
 * named a home, a path, or a scan. That suite has since been fixed; the rule stays because
 * the shape is trivial to reintroduce, and "fill the rows by calling shouldRun" is the
 * obvious thing for the next author to write.
 *
 * So the registry names the CALL instead, and it stays short on purpose: an entry is only
 * justified once a real suite has been caught by it, because a speculative list of
 * "functions that might read something" is a list nobody can keep true.
 *
 * `triggers` is the invocation, `requires` is the import that proves the real implementation
 * is in play (a suite holding only the `types` module cannot reach the scan), and `neutralized`
 * is every way the tree already stubs the scan out. A file that moves `os.homedir()` is exempt
 * too: the scan then walks the temp tree, which is exactly the intended fix.
 */
const MACHINE_SCANS: ReadonlyArray<{ what: string; triggers: RegExp; requires: RegExp; neutralized: RegExp }> = [
	{
		what: "a setup-wizard scene's shouldRun, which walks the real home for foreign config",
		triggers: /\.shouldRun\s*\??\.?\s*\(|selectSetupScenes\s*\(/,
		requires: /modes\/setup-wizard\/scenes\/(?!types)/,
		neutralized:
			/mock\.module\(\s*["'`][^"'`]*discovery\/import-scan|spyOn\(\s*[\w.]+\s*,\s*["'`](?:scanForeignConfig|discoverAgents)["'`]/,
	},
];

/**
 * Every spawn-rule violation in one comment-stripped source.
 *
 * Split out of {@link analyzeSource} because it is the only part of the analyzer that needs
 * three per-character passes, and most test files spawn nothing at all. The cheap token test
 * first means those files pay one regex instead of a binding scan, a string mask and a
 * per-file call regex, which is the difference between this gate costing one second and four.
 */
function spawnViolations(file: string, source: string): Violation[] {
	const found: Violation[] = [];
	if (!SPAWNS_SOMETHING.test(source)) return found;

	const bindings = stringBindings(source);
	const quoted = stringMask(source);
	const spawnCall = spawnCallRegex(source);
	for (let match = spawnCall.exec(source); match; match = spawnCall.exec(source)) {
		if (quoted[match.index]) continue;
		const open = source.indexOf("(", match.index);
		if (open < 0) continue;
		const text = callText(source, open);
		// A DECLARATION is not a call. `async function spawn(args: { ... })` is a helper this
		// tree really does define, and a typed parameter list is the one thing an argument list
		// never looks like, so the two together separate the definition from every invocation.
		if (DECLARATION_KEYWORD.test(source.slice(Math.max(0, match.index - 24), match.index))) continue;
		if (TYPED_PARAMETER.test(commandTargetOf(text))) continue;
		const line = lineAt(source, match.index);
		if (INSTALLED_BINARY_PATH.test(text) || VEYYON_IN_COMMAND_POSITION.test(text)) {
			found.push({ file, line, rule: "installed-binary-spawn", evidence: evidenceOf(text) });
			continue;
		}
		const target = commandTargetOf(text);
		// A quoted command that got past the two checks above is a literal naming something
		// other than veyyon, and the runner's own executable is Bun rather than the install.
		if (/^["'`]/.test(target) || RUNNER_EXECUTABLE.test(target)) continue;
		const resolved = /^[A-Za-z_$][\w$]*$/.test(target) ? bindings.get(target) : undefined;
		if (typeof resolved === "string") {
			// Re-ask the same two questions of the value the name stands for, so a command
			// spelled through a variable is judged exactly as the literal would have been.
			const asWritten = `("${resolved}",`;
			if (INSTALLED_BINARY_PATH.test(asWritten) || VEYYON_IN_COMMAND_POSITION.test(asWritten)) {
				found.push({
					file,
					line,
					rule: "installed-binary-spawn",
					evidence: `${evidenceOf(text)}  <- ${target} = "${resolved}"`,
				});
			}
			continue;
		}
		// An expression carrying at least one readable string literal, such as
		// `path.join(distDir, "veyyon")`, has already been judged by the two checks above:
		// they saw the same literal a reviewer would. What is left here is a target with no
		// readable part at all, and a spawn nobody can read is not a spawn anybody checked.
		// It fails closed and needs a reviewed allowlist entry. Note the residue this does
		// NOT prove: an install path assembled entirely out of non-literal parts still reads
		// as unresolvable rather than as dangerous, which is why the excuse is per file and
		// has to say what the target actually is.
		if (/["'`]/.test(target)) continue;
		found.push({
			file,
			line,
			rule: "unresolved-spawn-target",
			evidence: `${evidenceOf(text)}  <- command argument \`${target.slice(0, 40)}\` cannot be read`,
		});
	}
	return found;
}

/** Every violation in one file's source. */
export function analyzeSource(file: string, rawSource: string): Violation[] {
	const source = withoutComments(rawSource);
	const found: Violation[] = [];
	const isolated = isolates(source);
	// An `os.homedir()` write is only safe once `os.homedir()` ITSELF moved. A config-root
	// redirect leaves it answering the real home, so it cannot excuse this rule.
	const homedirMoved = movesHomedir(source);

	MUTATOR_CALL.lastIndex = 0;
	for (let match = MUTATOR_CALL.exec(source); match; match = MUTATOR_CALL.exec(source)) {
		const open = source.indexOf("(", match.index);
		if (open < 0) continue;
		const text = callText(source, open);
		const hardcoded = HARDCODED_HOME_LITERAL.test(text);
		if (!hardcoded && !(HOMEDIR_CALL.test(text) && !homedirMoved)) continue;
		found.push({ file, line: lineAt(source, match.index), rule: "real-home-write", evidence: evidenceOf(text) });
	}

	found.push(...spawnViolations(file, source));
	const which = source.search(WHICH_VEYYON);
	if (which >= 0) {
		found.push({
			file,
			line: lineAt(source, which),
			rule: "installed-binary-spawn",
			evidence: evidenceOf(source.slice(which, which + 140)),
		});
	}

	VEYYON_IN_SHELL_TEMPLATE.lastIndex = 0;
	for (let match = VEYYON_IN_SHELL_TEMPLATE.exec(source); match; match = VEYYON_IN_SHELL_TEMPLATE.exec(source)) {
		found.push({
			file,
			line: lineAt(source, match.index),
			rule: "installed-binary-spawn",
			evidence: evidenceOf(source.slice(match.index, source.indexOf("\n", match.index) + 1 || match.index + 140)),
		});
	}

	// The scan reads FOREIGN home trees (`~/.claude`, `~/.codex`), which only a homedir move
	// relocates. A config-root redirect moves `~/.veyyon` and nothing else, so it is not a pass.
	if (!homedirMoved) {
		for (const scan of MACHINE_SCANS) {
			if (!scan.requires.test(source) || scan.neutralized.test(source)) continue;
			const at = source.search(scan.triggers);
			if (at < 0) continue;
			const line = source.slice(at, source.indexOf("\n", at) + 1 || at + 100);
			found.push({
				file,
				line: lineAt(source, at),
				rule: "real-home-scan",
				evidence: `${evidenceOf(line)}  <- ${scan.what}`,
			});
		}
	}

	// Here EITHER mechanism is enough: the claim being checked is only that the file did
	// something real about the config root beyond assigning a variable Bun already ignored.
	if (!isolated) {
		const assign = source.search(ASSIGNS_HOME);
		if (assign >= 0) {
			found.push({
				file,
				line: lineAt(source, assign),
				rule: "fake-home-isolation",
				evidence: evidenceOf(source.slice(assign, source.indexOf("\n", assign) + 1 || assign + 140)),
			});
		}
	}

	// Unconditional: no isolation helper excuses this one, because naming the real home is
	// the opposite of isolating from it. The allowlist is the only way through.
	const reference = source.search(REAL_HOME_REFERENCE);
	if (reference >= 0) {
		found.push({
			file,
			line: lineAt(source, reference),
			rule: "real-home-reference",
			evidence: evidenceOf(source.slice(reference, source.indexOf("\n", reference) + 1 || reference + 140)),
		});
	}

	return found;
}

/** Test files under `packages/*​/test`, repo-relative and sorted. */
export function testSources(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.test\.tsx?$/.test(entry.name)) found.push(path.relative(REPO_ROOT, full));
		}
	};
	for (const pkg of readdirSync(path.join(REPO_ROOT, "packages"), { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		walk(path.join(REPO_ROOT, "packages", pkg.name, "test"));
	}
	return found.sort();
}

/** True when this exact file-and-rule pair is a declared exception. */
function isAllowed(violation: Violation): boolean {
	return ALLOWLIST.some(entry => entry.file === violation.file && entry.rule === violation.rule);
}

describe("no test reaches outside its sandbox", () => {
	const files = testSources();

	it("finds test files to check, so a broken walk cannot read as a clean tree", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("has no test that writes to, scans, or fakes isolation from the real home, or spawns the installed binary", () => {
		const violations: Violation[] = [];
		for (const file of files) {
			for (const violation of analyzeSource(file, readFileSync(path.join(REPO_ROOT, file), "utf8"))) {
				if (!isAllowed(violation)) violations.push(violation);
			}
		}
		const report = violations.map(v => `${v.file}:${v.line}  [${v.rule}]  ${v.evidence}`);
		expect(report).toEqual([]);
	});
});

describe("the allowlist", () => {
	it("gives a reason for every entry, because an unexplained exception cannot be reviewed", () => {
		const unexplained = ALLOWLIST.filter(entry => entry.reason.trim().length < 40).map(entry => entry.file);
		expect(unexplained).toEqual([]);
	});

	it("names only files that still exist and still violate the rule they are excused from", () => {
		const stale: string[] = [];
		for (const entry of ALLOWLIST) {
			let source: string;
			try {
				source = readFileSync(path.join(REPO_ROOT, entry.file), "utf8");
			} catch {
				stale.push(`${entry.file} (missing)`);
				continue;
			}
			const still = analyzeSource(entry.file, source).some(v => v.rule === entry.rule);
			if (!still) stale.push(`${entry.file} (no longer violates ${entry.rule})`);
		}
		expect(stale).toEqual([]);
	});
});

/**
 * The one runtime check in a static gate, and it earns its place.
 *
 * Everything above assumes the preload redirect is live. If it silently stops working,
 * every rule above still passes and 2,829 files quietly go back to reading the operator's
 * `.env`. That is not hypothetical: the redirect was written once and did nothing, because
 * a single `import * as os from "node:os"` in `temp-dir-janitor.ts` -- a sibling in the
 * preload's own module graph -- froze the `node:os` ESM namespace before the patch was
 * installed. `HOME` moved, `os.homedir()` did not, and nothing anywhere failed.
 *
 * So there are two checks. The first observes the redirect from inside a real test process,
 * which is the only place the answer is honest. The second forbids the specific import that
 * broke it, across the whole preload graph, so the next module added to that graph cannot
 * reintroduce it.
 */
describe("the home redirect", () => {
	it("has moved os.homedir() into a temp sandbox for this very process", () => {
		const sandbox = TEMP_HOME;
		// A throw, not an early return: `undefined` means the redirect is off in this process
		// and every assertion below would be skipped rather than failed.
		if (sandbox === undefined) throw new Error("the preload minted no sandbox home for this process");
		// Through the ESM namespace deliberately: that is the spelling production code uses,
		// and the spelling that was wrong the first time. Asking `require("node:os")` instead
		// would have reported success on the broken version.
		expect(os.homedir()).toBe(sandbox);
		expect(os.userInfo().homedir).toBe(sandbox);
		expect(process.env.HOME).toBe(sandbox);
		// Inside the tmpdir either way: the runner's shared sandbox and the per-process one
		// this module mints both live there, and no real home does.
		expect(sandbox.startsWith(os.tmpdir())).toBe(true);
	});

	it("keeps every module in the preload graph off the node:os ESM namespace", () => {
		const offenders: string[] = [];
		const seen = new Set<string>();
		const visit = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			let source: string;
			try {
				source = readFileSync(file, "utf8");
			} catch {
				return;
			}
			if (/^\s*import\s[^;]*from\s*["']node:os["']/m.test(withoutComments(source))) {
				offenders.push(path.relative(REPO_ROOT, file));
			}
			for (const match of source.matchAll(/^\s*import\s[^;]*from\s*["'](\.[^"']+)["']/gm)) {
				const target = path.resolve(path.dirname(file), match[1] ?? "");
				visit(target.endsWith(".ts") ? target : `${target}.ts`);
			}
		};
		visit(path.join(REPO_ROOT, "packages", "utils", "test", "helpers", "real-data-tripwire.ts"));
		// The walk has to have gone somewhere; an empty graph would pass vacuously.
		expect(seen.size).toBeGreaterThan(3);
		expect(offenders).toEqual([]);
	});
});

/**
 * The gate has to be able to FAIL, and these are what say so.
 *
 * A detector nobody has watched fire is indistinguishable from one that matches nothing,
 * and the second kind is worse than no gate at all: it reports a clean tree forever. Each
 * case below is a source string shaped exactly like the mistake it stands for.
 */
describe("the detectors", () => {
	const rulesFor = (source: string): Rule[] => analyzeSource("probe.test.ts", source).map(v => v.rule);

	it("catches a write built from os.homedir() in a file with no isolation", () => {
		expect(rulesFor(`fs.writeFileSync(path.join(os.homedir(), ".veyyon", "config.yml"), "x");`)).toEqual([
			"real-home-write",
		]);
	});

	it("catches a write to a hardcoded home path even when the file IS isolated", () => {
		const source = [
			`spyOn(os, "homedir").mockReturnValue(temp);`,
			`fs.writeFileSync("/home/dev/.veyyon/credentials.db", "x");`,
		].join("\n");
		expect(rulesFor(source)).toEqual(["real-home-write"]);
	});

	it("catches a write spread over several lines, which a per-line scan would miss", () => {
		const source = ["await fs.promises.mkdir(", `\tpath.join(os.homedir(), ".veyyon", "profiles"),`, ");"].join("\n");
		expect(rulesFor(source)).toEqual(["real-home-write"]);
	});

	it("catches a spawn of the installed binary by path", () => {
		expect(rulesFor(`Bun.spawn(["/home/dev/.local/bin/veyyon", "--version"]);`)).toEqual(["installed-binary-spawn"]);
	});

	it("catches a spawn of a bare `veyyon`, which resolves through PATH to the installed one", () => {
		expect(rulesFor(`const out = spawnSync("veyyon", ["auth", "list"]);`)).toEqual(["installed-binary-spawn"]);
	});

	it("catches resolving `veyyon` from PATH even when nothing is spawned yet", () => {
		expect(rulesFor(`const bin = Bun.which("veyyon");`)).toEqual(["installed-binary-spawn"]);
	});

	/**
	 * `execSync("veyyon --version")` passes the whole command line as ONE string, so the
	 * name is followed by a space rather than a closing quote. The first version of this
	 * detector required the quote and walked straight past the shape.
	 */
	it("catches a bare `veyyon` at the head of a single command STRING, not just an argv array", () => {
		expect(rulesFor(`const out = execSync("veyyon auth list", { encoding: "utf8" });`)).toEqual([
			"installed-binary-spawn",
		]);
	});

	/** `Bun.spawn` also takes `{ cmd: [...] }`, where the command is not the first token. */
	it("catches a bare `veyyon` inside a { cmd: [...] } options object", () => {
		expect(rulesFor(`Bun.spawnSync({ cmd: ["veyyon", "--version"], stdout: "pipe" });`)).toEqual([
			"installed-binary-spawn",
		]);
	});

	/** A shell template runs a command through none of the call heads the spawn scan knows. */
	it("catches `veyyon` run through a Bun shell template, which no spawn call head appears in", () => {
		expect(rulesFor("const out = await Bun.$`veyyon auth list`.text();")).toEqual(["installed-binary-spawn"]);
	});

	/** Only the COMMAND is the installed binary. `veyyon` as an argument to `bun` is this tree's own. */
	it("does NOT flag a shell template whose command is bun and whose argument merely names veyyon", () => {
		expect(rulesFor("await $`bun run ./packages/coding-agent/src/cli.ts veyyon --version`;")).toEqual([]);
	});

	/**
	 * A hyphenated neighbour is a different program. Without this the class after the name
	 * could be widened to "anything", and `veyyon-cloud` would start failing the build.
	 */
	it("does NOT flag a spawn of a differently named binary that starts with the same letters", () => {
		expect(rulesFor(`spawnSync("veyyon-cloud", ["--version"]);`)).toEqual([]);
	});

	it("catches a HOME assignment with no homedir spy and no config-root redirect", () => {
		expect(rulesFor(`process.env.HOME = tempHome;`)).toEqual(["fake-home-isolation"]);
	});

	it("does NOT flag a HOME assignment backed by a homedir spy", () => {
		const source = [`process.env.HOME = tempHome;`, `spyOn(os, "homedir").mockReturnValue(tempHome);`].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	it("does NOT flag a HOME assignment backed by a config-root redirect", () => {
		const source = [`process.env.HOME = tempHome;`, `enterIsolatedConfigRoot("suite");`].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	/**
	 * Reading the variable is not redirecting it. This escape hatch used to be
	 * `source.includes("VEYYON_CONFIG_DIR")`, so a suite that merely asserted on the
	 * variable was recorded as isolated and had its fake HOME waved through.
	 */
	it("does NOT accept a mere MENTION of VEYYON_CONFIG_DIR as a config-root redirect", () => {
		const source = [`process.env.HOME = tempHome;`, `expect(process.env.VEYYON_CONFIG_DIR).toBeUndefined();`].join(
			"\n",
		);
		expect(rulesFor(source)).toEqual(["fake-home-isolation"]);
	});

	it("DOES accept an assignment of VEYYON_CONFIG_DIR, including into a child environment", () => {
		expect(rulesFor([`process.env.HOME = home;`, `childEnv.VEYYON_CONFIG_DIR = name;`].join("\n"))).toEqual([]);
		expect(rulesFor([`process.env.HOME = home;`, `const env = { VEYYON_CONFIG_DIR: name };`].join("\n"))).toEqual([]);
	});

	/**
	 * The scan rule, which is the only one that can see the worst case in this tree: a
	 * suite whose source names no path at all, and whose one `shouldRun` call reads 39
	 * paths in the developer's home including `~/.env`.
	 */
	it("catches a setup-wizard scene's shouldRun in a file that imports the real scenes", () => {
		const source = [
			`import { importSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";`,
			`await scene.shouldRun?.(ctx);`,
		].join("\n");
		expect(rulesFor(source)).toEqual(["real-home-scan"]);
	});

	it("does NOT flag a shouldRun call in a file that only holds the scene TYPES", () => {
		const source = [
			`import type { SetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";`,
			`await scene.shouldRun?.(ctx);`,
		].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	it("does NOT flag a shouldRun call once the scan it reaches is stubbed out", () => {
		const mocked = [
			`import { importSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";`,
			`mock.module("@veyyon/coding-agent/discovery/import-scan", () => ({ scanForeignConfig: async () => [] }));`,
			`await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true });`,
		].join("\n");
		expect(rulesFor(mocked)).toEqual([]);
		const spied = [
			`import { agentsSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/agents";`,
			`vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });`,
			`await agentsSetupScene.shouldRun?.(ctx);`,
		].join("\n");
		expect(rulesFor(spied)).toEqual([]);
	});

	it("does NOT flag a shouldRun call in a file whose home is already a temp tree", () => {
		const source = [
			`import { importSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";`,
			`useTempHome();`,
			`await scene.shouldRun?.(ctx);`,
		].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	it("does NOT flag os.homedir() inside a write when the file moved os.homedir() first", () => {
		const source = [
			`spyOn(os, "homedir").mockReturnValue(temp);`,
			`fs.mkdirSync(path.join(os.homedir(), ".veyyon"), { recursive: true });`,
		].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	/**
	 * `enterIsolatedConfigRoot` moves `~/.veyyon` and deliberately leaves `os.homedir()`
	 * reporting the real home (its own header says so). Accepting it here would wave through
	 * a write into the developer's actual home directory, and the file would read as isolated
	 * to every reviewer.
	 */
	it("STILL flags an os.homedir() write when only the config root moved, not os.homedir()", () => {
		const source = [
			`const isolated = enterIsolatedConfigRoot("suite");`,
			`fs.mkdirSync(path.join(os.homedir(), ".claude", "skills"), { recursive: true });`,
		].join("\n");
		expect(rulesFor(source)).toEqual(["real-home-write"]);
	});

	/** Same reasoning for the scan: the trees it walks are `~/.claude` and `~/.codex`. */
	it("STILL flags a machine scan when only the config root moved", () => {
		const source = [
			`import { importSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/import";`,
			`const isolated = enterIsolatedConfigRoot("suite");`,
			`await scene.shouldRun?.(ctx);`,
		].join("\n");
		expect(rulesFor(source)).toEqual(["real-home-scan"]);
	});

	it("does NOT flag an installed-binary path that is only a string handed to a pure function", () => {
		expect(rulesFor(`expect(resolveUpdateMethod("/home/u/.local/bin/veyyon")).toBe("binary");`)).toEqual([]);
	});

	it("does NOT flag a spawn of this repository's own artifact", () => {
		expect(rulesFor(`Bun.spawn([path.join(distDir, "veyyon"), "--version"]);`)).toEqual([]);
	});

	/**
	 * The hole this rule was added for. The gate reported a clean tree on a file doing
	 * exactly this, because the analyzer only ever read the text INSIDE the offending call.
	 */
	it("catches the installed binary spawned through a variable holding its name", () => {
		const source = [`const bin = "veyyon";`, `spawnSync(bin, ["auth", "list"]);`].join("\n");
		expect(rulesFor(source)).toEqual(["installed-binary-spawn"]);
	});

	it("catches an installed-binary PATH spawned through a variable", () => {
		const source = [`const cli = "~/.local/bin/veyyon";`, `Bun.spawn([cli, "--version"]);`].join("\n");
		expect(rulesFor(source)).toEqual(["installed-binary-spawn"]);
	});

	it("refuses a spawn whose command nothing in the file can read", () => {
		expect(rulesFor(`Bun.spawnSync([layout.target, "--wait"]);`)).toEqual(["unresolved-spawn-target"]);
	});

	/** A name bound twice stands for nothing, so it fails closed rather than picking one. */
	it("refuses a command whose variable is bound more than once", () => {
		const source = [`let tool = "git";`, `let tool = "veyyon";`, `spawnSync(tool, ["status"]);`].join("\n");
		expect(rulesFor(source)).toEqual(["unresolved-spawn-target"]);
	});

	it("does NOT flag a command resolved through a variable to something harmless", () => {
		const source = [`const tool = "git";`, `spawnSync(tool, ["status"]);`].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	it("does NOT flag the test runner's own executable", () => {
		expect(rulesFor(`Bun.spawn([process.execPath, cliEntry, "--help"]);`)).toEqual([]);
	});

	/**
	 * `registry.spawn(session, ...)` and `PATTERN.exec(text)` are not process spawns, and a
	 * rule that refuses what it cannot read has to know the difference or it refuses the tree.
	 */
	it("does NOT read a domain method named spawn or a regex exec as a process spawn", () => {
		const source = [`await registry.spawn(session, { cli: "fast" });`, `const m = PATTERN.exec(text);`].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	/** A child_process namespace import keeps member calls in scope, so tightening is not a hole. */
	it("catches the installed binary through a child_process namespace alias", () => {
		const source = [`import * as cp from "node:child_process";`, `cp.spawnSync("veyyon", ["auth"]);`].join("\n");
		expect(rulesFor(source)).toEqual(["installed-binary-spawn"]);
	});

	/** A call head QUOTED inside an embedded source string is text, not a call. */
	it("does NOT read a spawn written inside a string of embedded source as a spawn", () => {
		expect(rulesFor(`const src = ["  async exec(command, cwd, options) {", "  }"].join("\\n");`)).toEqual([]);
	});

	/**
	 * A file that DEFINES a helper called `spawn` is not spawning anything, and this tree has
	 * one: `task/autoload-skill-resolution-scope.test.ts` declares `async function spawn(args:
	 * { autoloadSkills: string[]; ... })`. Reading a declaration as an unreadable spawn target
	 * would put a suite that starts no process on the allowlist.
	 */
	it("does NOT read a function DECLARATION named spawn as a spawn", () => {
		const source = [
			`async function spawn(args: { autoloadSkills: string[]; cwd?: string }) {`,
			`	return args;`,
			`}`,
		].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	it("does NOT read a typed method parameter list as a spawn argument", () => {
		expect(rulesFor(`class Runner { async spawn(options: { cwd: string }) { return options; } }`)).toEqual([]);
	});

	it("does NOT flag a temp directory that merely reads like a home path", () => {
		expect(rulesFor(`fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-suite-"));`)).toEqual([]);
	});

	it("catches an import of the tripwire internals, the named door to the real config root", () => {
		const source = [
			`import { __tripwire } from "../../utils/test/helpers/real-data-tripwire";`,
			`const realRoot = __tripwire.FORBIDDEN[0];`,
		].join("\n");
		expect(rulesFor(source)).toEqual(["real-home-reference"]);
	});

	it("catches a suite putting the operator's real home back under it", () => {
		expect(rulesFor(`beforeAll(() => { enterRealHome(); });`)).toEqual(["real-home-reference"]);
	});

	it("catches a suite reading the pre-redirect root out of the environment", () => {
		expect(rulesFor(`const root = process.env.VEYYON_TEST_REAL_CONFIG_ROOT;`)).toEqual(["real-home-reference"]);
	});

	it("does NOT flag a suite that merely uses the sandbox home the preload already gave it", () => {
		expect(rulesFor(`const scratch = path.join(os.homedir(), "scratch");`)).toEqual([]);
	});
});
