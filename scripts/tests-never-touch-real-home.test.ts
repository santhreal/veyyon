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
 *  5. redirect `VEYYON_CONFIG_DIR` to a bare directory NAME. The variable is joined
 *     onto `os.homedir()`, so a fresh `.veyyon-<suite>-<id>` is a new config root
 *     INSIDE the home it was supposed to escape,
 *  6. NAME the real home at all -- by importing the tripwire's `__tripwire`, by
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
 * The bare-name case is the fake-isolation case one level down, and it went unseen for
 * longer because the gate's own acceptance hid it: assigning `VEYYON_CONFIG_DIR` is proof
 * that a file did something about the config root, so a suite that assigned a fresh NAME
 * was recorded as isolated and never asked where the name pointed. 131 abandoned
 * `~/.veyyon-mnemopi-profile-iso-*` directories accumulated in one operator's home
 * underneath this gate. The value is now read as well as the assignment, and the two
 * questions stay separate: `REDIRECTS_CONFIG_DIR` still says the root moved, and
 * `CONFIG_DIR_LITERAL` says whether it moved anywhere useful.
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
 * misbehaves. Reading the sources sees all six, needs no test process, and finishes
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

/** The seven things this gate refuses. */
export type Rule =
	| "real-home-write"
	| "installed-binary-spawn"
	| "unresolved-spawn-target"
	| "fake-home-isolation"
	| "bare-config-dir-name"
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
	{
		file: "packages/utils/test/sandbox-gate-contracts.test.ts",
		rule: "real-home-reference",
		reason:
			"It is the gate's own suite, and half its subject is the tripwire, which cannot be probed without naming the variable that tells the tripwire what to forbid. What it names is NOT the real config root: every occurrence sets `VEYYON_TEST_REAL_CONFIG_ROOT` to a freshly `mkdtemp`ed directory in the child it spawns, precisely so a door that turns out to be UNGUARDED writes there instead of into the operator's home — which is what makes the red proofs of the six write doors safe to run at all. Each probe removes its own root in a `finally`, and each asserts the root is empty afterwards, so an unguarded door is reported by the absence of the file rather than by damage. The real `~/.veyyon` is never resolved, opened, or written by this file.",
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
	// The four below are all `bare-config-dir-name`, and they have one shape between them:
	// the config-dir NAME is the SUBJECT, not the isolation. Each one assigns a name, asks a
	// resolver or a helper what it does with it, and asserts on the STRING that comes back.
	// None of them opens the path, so none of them creates the directory the rule exists to
	// prevent, and giving any of them a `path.relative` value would delete the thing under
	// test. A suite that starts writing through the name it invents stops matching these
	// reasons, which is why the entries name the absence of a write rather than the suite.
	{
		file: "packages/utils/test/config-dir-env-alias.test.ts",
		rule: "bare-config-dir-name",
		reason:
			"Its subject is which environment variable NAMES the config directory: it sets `VEYYON_CONFIG_DIR` to `.veyyon-branded` and requires `getConfigDirName()` to answer exactly that, and to keep answering it when the dropped `OMP_CONFIG_DIR` and `PI_CONFIG_DIR` aliases are set alongside. A relative temp-root value would make the assertion a tautology about a string nobody is testing. It calls no filesystem mutator at all: the name never becomes a directory.",
	},
	{
		file: "packages/utils/test/dirs-config-root-ignores-xdg-config-home.test.ts",
		rule: "bare-config-dir-name",
		reason:
			'It proves that `XDG_CONFIG_HOME` does not move the config root and that renaming it is `VEYYON_CONFIG_DIR`\'s job alone, so the case sets `.veyyon-renamed` and asserts the root resolves to `path.join(os.homedir(), ".veyyon-renamed")`, where the home-relative join IS the contract being pinned. Everything it writes goes to the `mkdtempSync` root it removes in `afterEach`; the renamed root is a string it compares and never opens.',
	},
	{
		file: "packages/coding-agent/test/discovery/veyyon-config-dir.test.ts",
		rule: "bare-config-dir-name",
		reason:
			"It pins that `getConfigDirs` routes the user scope through the config root and the ACTIVE profile rather than the caller's `ctx.home`, which needs a config-dir name distinguishable from the default: `.config/veyyon`, asserted back as a path under `os.homedir()`. The suite is two `expect` calls on returned paths and contains no filesystem call of any kind.",
	},
	{
		file: "packages/coding-agent/test/helpers/hermetic-spawn-env.test.ts",
		rule: "bare-config-dir-name",
		reason:
			"It is the suite that proves `hermeticSpawnEnv()` STRIPS this variable. It has to set `.veyyon-guard-test` on the real `process.env` first, because the assertion is that the returned child environment no longer carries it and points at a temp home instead. An already-relative value would pass whether the helper stripped it or not. It builds environment objects and spawns nothing.",
	},
	// The four below are not suites at all. They are the modules the walk started reading
	// when it stopped stopping at the `.test.ts` suffix, and two of them ARE the protection
	// this gate reports on: the rules describe what a test may not do, and the machinery that
	// enforces them has to do those things once, in one place, so that nothing else has to.
	{
		file: "packages/utils/test/helpers/sandbox-home.ts",
		rule: "fake-home-isolation",
		reason:
			"It is the redirect itself. It assigns `process.env.HOME` because it has just replaced `os.homedir` and `os.userInfo` on the `node:os` object every module shares, and the environment variable is the half of the move that a spawned child reads. The gate looks for a `spyOn` and there is none: a preload cannot spy on a module the suites have not imported yet, which is the whole reason this runs before them.",
	},
	{
		file: "packages/utils/test/helpers/sandbox-home.ts",
		rule: "real-home-reference",
		reason:
			"It is the producer of `VEYYON_TEST_REAL_CONFIG_ROOT`, not a consumer. It captures the real home BEFORE the redirect and publishes the real config root under that name so the tripwire, and every child process a test spawns, can still recognise the directory they must refuse. Nothing else can name it once the redirect is in place, which is the point.",
	},
	{
		file: "packages/utils/test/helpers/real-data-tripwire.ts",
		rule: "real-home-reference",
		reason:
			"It is the guard that refuses writes to the real config root, so it has to read `VEYYON_TEST_REAL_CONFIG_ROOT` to know which directory that is. It opens nothing: the value is compared against the target of every mutating `node:fs` call and the comparison is the entire feature.",
	},
	{
		file: "packages/coding-agent/test/helpers/temp-home-cleanup.ts",
		rule: "fake-home-isolation",
		reason:
			"Its only assignment of `process.env.HOME` RESTORES the value a suite saved before overwriting it, in a teardown that also removes the two temp directories. Putting a captured value back is the opposite of claiming isolation, and requiring a homedir spy in a nine-line cleanup helper would mean spying in order to undo.",
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
 * Every `const NAME = "literal"` and `const NAME = ["literal", ...]` in the file, so a
 * command spelled through a variable can still be read.
 * `const bin = "veyyon"; spawnSync(bin, ["auth", "list"])` scanned clean before this
 * existed, and unlike a redirected WRITE, which the real-data tripwire refuses at runtime
 * whatever the path was called, a spawn of the installed binary has no runtime backstop at
 * all: it reaches the operator's real profile, credentials and model spend on the first
 * call and nothing reports it.
 *
 * THE ARRAY FORM IS NOT A CONVENIENCE. `const emit = ["sh", "-c", "..."]` followed by
 * three `spawn(emit)` calls is the single most natural way to write a test that runs one
 * command several ways, and it used to produce three `unresolved-spawn-target` violations
 * whose only honest resolution was an allowlist entry -- an excuse recorded against a file
 * whose command is `sh`, sitting in plain sight one line above the call. Every allowlist
 * entry is a place the gate has stopped looking, so paying one for a target the gate could
 * simply read is the worst trade available: it buys nothing and permanently blinds the
 * rule for that whole file, including the veyyon spawn somebody adds to it next year.
 * Binding the array's HEAD is exactly right, because the head is the command and the tail
 * is its arguments.
 *
 * A name bound more than once resolves to nothing rather than to its first value, and an
 * interpolated template is not a constant. Both then fall through to the unresolvable
 * case, which is a violation, so being unable to read a name never reads as safe.
 */
const STRING_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const ARRAY_HEAD_BINDING =
	/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\[\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const AMBIGUOUS = Symbol("bound more than once");

function stringBindings(source: string): Map<string, string | typeof AMBIGUOUS> {
	const bindings = new Map<string, string | typeof AMBIGUOUS>();
	for (const pattern of [STRING_BINDING, ARRAY_HEAD_BINDING]) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
			const name = match[1] as string;
			const value = match[3] as string;
			bindings.set(name, bindings.has(name) || value.includes("${") ? AMBIGUOUS : value);
		}
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

/**
 * Where a `VEYYON_CONFIG_DIR` value lands, which the rule above deliberately does not ask.
 *
 * The variable is a directory NAME joined onto `os.homedir()`, never a path that replaces
 * it, so `VEYYON_CONFIG_DIR = ".veyyon-<suite>-<id>"` names a brand new directory INSIDE
 * the home it was meant to escape. It reads as isolation, it isolates the suite from other
 * suites, and it isolates it from nobody else: 131 `~/.veyyon-mnemopi-profile-iso-*`
 * directories were found in one operator's home, created by a suite that was doing exactly
 * this. The only correct value is one that walks back OUT of the home,
 * `path.relative(os.homedir(), tempRoot)`, which is what `enterIsolatedConfigRoot()` writes.
 *
 * This is a rule of its own rather than a tightening of `REDIRECTS_CONFIG_DIR`, and the
 * distinction is worth stating because the two look contradictory. That regex answers "did
 * this file move the config root away from `~/.veyyon`", which a bare name genuinely does,
 * and that is all the `fake-home-isolation` rule needs to know. This one answers the
 * question nobody was asking: WHERE it moved it to. Folding them together would have to
 * pick one answer for both, and either choice is wrong: refusing the acceptance breaks
 * every suite that redirects a child's environment, and widening it excuses the defect.
 */
const CONFIG_DIR_LITERAL = /VEYYON_CONFIG_DIR(?:["'`]\s*\])?\s*[=:](?!=)\s*(["'`])([^"'`\n]*)/g;

/** `const VEYYON_CONFIG_DIR = ".veyyon"` names a local binding; nothing is redirected. */
const DECLARES_A_BINDING = /\b(?:const|let|var)\s+$/;

/** The assignment target is THIS process's environment, so this process's home is the base. */
const THIS_PROCESS_ENV = /process\.env(?:\.|\[\s*["'`])$/;

/**
 * A value that does not stay under the home it is joined onto: the `..`-relative form
 * `path.relative` produces, an absolute path (refused at startup, a different defect), or
 * an interpolation in first position, which says the value is computed and unreadable here.
 */
const LEAVES_THE_HOME = /^(?:\.\.[\\/]|[\\/]|[A-Za-z]:[\\/]|\$\{)/;

/**
 * The file hands a HOME to whatever will join the name onto it.
 *
 * For a CHILD environment that is the whole answer: the child reads `HOME` before its own
 * resolver runs, so `{ HOME: tempRoot, VEYYON_CONFIG_DIR: ".veyyon" }` is a config root in
 * the temp root and not in anyone's home. It is deliberately NOT accepted for an assignment
 * into this process's environment, where the same spelling does nothing: Bun resolved
 * `os.homedir()` at process start, which is the trap the whole gate exists for.
 */
const HANDS_OVER_A_HOME = /(?:process\.env\.HOME|process\.env\[\s*["'`]HOME["'`]\s*\]|(?<![\w$.])HOME)\s*[=:](?!=)/;

/** Every `VEYYON_CONFIG_DIR` value that names a directory inside somebody's real home. */
function bareConfigDirViolations(file: string, source: string): Violation[] {
	const found: Violation[] = [];
	const homedirMoved = movesHomedir(source);
	const childHome = HANDS_OVER_A_HOME.test(source);
	CONFIG_DIR_LITERAL.lastIndex = 0;
	for (let match = CONFIG_DIR_LITERAL.exec(source); match; match = CONFIG_DIR_LITERAL.exec(source)) {
		const before = source.slice(Math.max(0, match.index - 40), match.index);
		if (DECLARES_A_BINDING.test(before)) continue;
		const value = match[2] ?? "";
		if (value === "" || LEAVES_THE_HOME.test(value)) continue;
		if (THIS_PROCESS_ENV.test(before) ? homedirMoved : childHome) continue;
		found.push({
			file,
			line: lineAt(source, match.index),
			rule: "bare-config-dir-name",
			evidence: evidenceOf(source.slice(match.index, match.index + 140)),
		});
	}
	return found;
}

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

/** Character codes the comment scan compares, so the hot loop never allocates a substring. */
const SLASH = 47;
const STAR = 42;
const NEWLINE = 10;
const BACKSLASH = 92;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const BACKTICK = 96;
/** A comment keeps its newlines and nothing else, so every other byte becomes a space. */
const SPACE = " ";
const NOT_NEWLINE = /[^\n]/g;

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
 *
 * The scan keeps one chunk per span rather than a per-character array. The state machine is
 * the same one, byte for byte in its output; what changed is that a 40 KB file now costs a
 * handful of slices instead of 40,000 single-character strings and a 40,000-element join.
 * That mattered: this helper runs over every test file in the repository, and the array was
 * most of why the whole-tree case measured 14.4s. A file with no comment at all is returned
 * as-is, which is the same string the copy-and-join produced.
 */
export function withoutComments(source: string): string {
	const length = source.length;
	let chunks: string[] | null = null;
	// First byte not yet handed to a chunk. Everything before it is already accounted for.
	let kept = 0;
	let i = 0;
	while (i < length) {
		const c = source.charCodeAt(i);
		if (c === SLASH) {
			const next = source.charCodeAt(i + 1);
			if (next === SLASH) {
				const start = i;
				while (i < length && source.charCodeAt(i) !== NEWLINE) i++;
				chunks ??= [];
				chunks.push(source.slice(kept, start), SPACE.repeat(i - start));
				kept = i;
				continue;
			}
			if (next === STAR) {
				const end = source.indexOf("*/", i + 2);
				const stop = end < 0 ? length : end + 2;
				chunks ??= [];
				// Only newlines survive a block comment, and they must, or every line number
				// reported after the comment shifts.
				chunks.push(source.slice(kept, i), source.slice(i, stop).replace(NOT_NEWLINE, " "));
				kept = stop;
				i = stop;
				continue;
			}
			i++;
			continue;
		}
		if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE || c === BACKTICK) {
			i++;
			while (i < length) {
				const inner = source.charCodeAt(i);
				if (inner === BACKSLASH) {
					i += 2;
					continue;
				}
				if (inner === c) break;
				i++;
			}
			i++;
			continue;
		}
		i++;
	}
	if (chunks === null) return source;
	chunks.push(source.slice(kept));
	return chunks.join("");
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

	// Runs whether or not the file counts as isolated: a bare name is what the acceptance
	// above accepts, so this is the only place the value itself is ever read.
	found.push(...bareConfigDirViolations(file, source));

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

/**
 * Every TypeScript module under `packages/*​/test`, repo-relative and sorted.
 *
 * Not only `*.test.ts`. A shared setup module or a helper is a test file that happens to
 * export instead of declaring cases, it runs inside the same process with the same reach,
 * and it is where a mistake is worst rather than mildest: `packages/mnemopi/test/setup.ts`
 * decides the config root for all 106 mnemopi suites at once. The walk used to stop at the
 * `.test.ts` suffix, so the one file that could leak on behalf of a whole package was the
 * one file nothing read.
 */
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
			else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(REPO_ROOT, full));
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
		// 20s, declared rather than inherited, and lowered from the 60s that stood while the
		// analyzer was expensive. This case reads and analyses every `.ts` file under
		// `packages/<pkg>/test`, 4,575 of them, so its cost grows with the suite, and it measured
		// 14.4s against the 5,000ms default. A timeout is not a violation, but it fails
		// identically to one, and a gate that goes red on timing is a gate people learn to
		// re-run, which is how they come to re-run it on the day it is telling the truth.
		//
		// What changed is `withoutComments`, which used to copy every source into a
		// per-character array. Measured over all 4,575 files (30,686,571 bytes) in one warm
		// process, interleaving the two implementations so a load spike lands on both: the helper
		// alone went from a 326ms median to 112ms and a full `analyzeSource` pass over the tree
		// from 2,303ms to 1,958ms, with the violation set identical, 24 findings before the
		// allowlist, and every stripped source byte-identical. The same comparison on a box
		// shared with five other builds read 1,261ms to 287ms and 4,072ms to 2,902ms, so the
		// ratio is load-dependent and the helper is worth about three to four times less than it
		// was. Most of what remains is file reading and the other per-file scans, not this one.
		//
		// The whole file runs in 2.3s idle and the case alone in 2.7s. 20s is several times the
		// worst single run observed under load, and still fails long before a real regression
		// could hide inside it. The number is the only thing here that may be raised, and only
		// alongside the measurement that justifies it. Widening it to hide a violation would not
		// be honest.
	}, 20_000);
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

	/**
	 * `const argv = ["sh", "-c", "..."]` reused across several spawns is the ordinary way to
	 * write "run this one command three ways", and reading only STRING bindings made every
	 * one of those calls an `unresolved-spawn-target`. That is worse than a false negative:
	 * the only way to clear it is an allowlist entry, and an allowlist entry switches the
	 * whole rule off for that file, so a readable `sh` bought permanent blindness to a
	 * `veyyon` added to the same file later. The head of the array is the command.
	 */
	it("reads a command out of an argv array bound to a variable", () => {
		const source = [`const emit = ["sh", "-c", "printf x"];`, `spawn(emit).bytes();`].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	it("still catches the installed binary when it is the head of a bound argv array", () => {
		const source = [`const argv = ["veyyon", "auth", "list"];`, `Bun.spawnSync(argv);`].join("\n");
		expect(rulesFor(source)).toEqual(["installed-binary-spawn"]);
	});

	/** The head is the command; an argument further along says nothing about what runs. */
	it("does not let a later array element stand in for the command", () => {
		const source = [`const argv = [runner, "veyyon"];`, `Bun.spawnSync(argv);`].join("\n");
		expect(rulesFor(source)).toEqual(["unresolved-spawn-target"]);
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

	/**
	 * The comment blanking is what lets a suite DOCUMENT one of these traps, and the byte
	 * positions it preserves are what makes a reported line number true. Both are asserted
	 * here because the scan splices spans rather than copying characters, and a span it
	 * mismeasures reports a real violation at the wrong line, which reads as a false alarm
	 * and is how a gate stops being believed.
	 */
	it("ignores the mistake a comment describes and reports the real one at its true line", () => {
		const source = [
			`/**`,
			` * A suite once ran spawnSync("veyyon", ["auth"]) and wrote to os.homedir().`,
			` */`,
			`// process.env.HOME = tempHome;`,
			`const url = "https://example.com//still-a-string"; // trailing note`,
			`spawnSync("veyyon", ["auth", "list"]);`,
		].join("\n");
		const found = analyzeSource("probe.test.ts", source);
		expect(found.map(v => v.rule)).toEqual(["installed-binary-spawn"]);
		expect(found[0]?.line).toBe(6);
	});

	/** An unterminated block comment has no end to stop at, so it swallows the rest of the file. */
	it("blanks an unterminated block comment through the end of the file", () => {
		const source = [
			`spawnSync("git", ["status"]);`,
			`/* everything below is commented out and never closed`,
			`spawnSync("veyyon", ["auth"]);`,
		].join("\n");
		expect(rulesFor(source)).toEqual([]);
	});

	/**
	 * The 131-directory pattern, verbatim. A fresh dot-name, a snowflake to keep runs apart,
	 * and a resolver that joins the whole thing onto the operator's home.
	 */
	it("catches a VEYYON_CONFIG_DIR set to a fresh directory NAME, which lands inside the home", () => {
		const source = [
			// The `${...}` below is the FIXTURE: this string is source text the analyzer reads, and
			// the interpolation is what made every run mint a new directory. A template literal here
			// would evaluate a `Snowflake` that is not in scope and delete the case.
			// biome-ignore lint/suspicious/noTemplateCurlyInString: quoted source text, not a missed template
			"process.env.VEYYON_CONFIG_DIR = `.veyyon-mnemopi-profile-iso-${Snowflake.next()}`;",
			`refreshDirsFromEnv();`,
		].join("\n");
		expect(rulesFor(source)).toEqual(["bare-config-dir-name"]);
	});

	/**
	 * The negative control, and the reason the rule above cannot be satisfied by flagging
	 * every assignment: the sanctioned value is a `path.relative` result, and the two forms
	 * differ only in where they point. A rule that could not tell them apart would either
	 * fail `enterIsolatedConfigRoot` itself or catch nothing.
	 */
	it("does NOT flag a value computed back out of the home, which is what isolation looks like", () => {
		const relative = [
			`process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);`,
			`refreshDirsFromEnv();`,
		].join("\n");
		expect(rulesFor(relative)).toEqual([]);
		// The same value after `path.relative` has run, written out: it climbs OUT of the home.
		expect(rulesFor(`process.env.VEYYON_CONFIG_DIR = "../tmp/veyyon-config-root-probe-1";`)).toEqual([]);
	});
});
