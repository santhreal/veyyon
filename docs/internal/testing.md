# Testing

How to run the suites and how to write a test that earns its place. The rules here are
the enforced ones from the repo `AGENTS.md`, expanded for contributors.

## Running

From the repo root (or `--cwd=packages/coding-agent` for package-local runs):

| Command | What runs |
| --- | --- |
| `bun run check` | The gate: type check, TS and Rust, in parallel (`check:ts` + `check:rs`). Run this before every push. |
| `bun run check:ts` | `tsgo --noEmit` across every package. Despite the name it runs no Biome; `bun run check:tools` is the Biome gate. |
| `bun run test` | The local TS test runner (`scripts/ci-test-ts.ts local`). |
| `bun run test:ts` | Full local TypeScript suite (`local-ts`). |
| `bun run ci:test:ts:workspace` | The exact workspace bucket CI runs. |
| `bun run ci:build:native` | Build the `veyyon_natives` addon, required before tests that touch native paths. |

Native/integration tests need the addon built first (`ci:build:native`); the CI test
jobs download a prebuilt addon artifact instead.

### Buckets (`scripts/ci-test-ts.ts`)

| Mode | Contents |
| --- | --- |
| `workspace` | Fast packages (hashline, wire, utils, catalog, ai, agent, argot, stats, tool-render, swarm-extension, deepswe-bench) + script gates |
| `native` | natives, tui, typescript-edit-benchmark, metaharness, collab-web |
| `coding-agent-singleton` | Settings / global-state suites (one process; do not chunk) |
| `coding-agent-ui` | TUI/interactive suites (chunk size 5; ghostty GC ceiling) |
| `coding-agent-runtime` | Session, RPC, SDK, MCP, extensions |
| `coding-agent-native` | Tools, bash, browser, sqlite, spawn |
| `coding-agent-heavy` | All coding-agent buckets |
| `local` / `local-ts` | Full local TS (+ Rust for `local`) |

New tests join these buckets by path and content markers in `ci-test-ts.ts`. Do not invent a second runner.

A new PACKAGE joins by being added to one of the three lists in `ci-test-ts.ts`:
`fastWorkspacePackages`, `nativeAndIntegrationPackages`, or
`localOnlyWorkspacePackages`. Pick the fast list unless the package starts
servers, loads the native addon, or needs a browser-ish environment.
`packages/coding-agent` is the one exception: its suites are discovered by
walking the package, so it is not listed.

Nothing about a package makes the runner find it. Seven packages shipped working
test suites that no mode executed, for exactly that reason, until
`scripts/workspace-test-coverage.test.ts` began checking the lists against the
tree. That guard fails if a package ships tests and no list names it, and also if
a list names a package that ships none, so neither direction can drift again.

## Quality bar (SQLite-grade)

The goal is not a large case count. The goal is a suite that catches silent semantic
breaks. Headcount is a byproduct of covering real contracts.

SQLite-style rules:

1. **Every bug is permanent.** A fixed failure becomes a named regression with exact
   asserts. Prefer a corpus row over a one-off buried in an unrelated file.
2. **Positive + negative twin.** Every rule has a case that must fire and a sanitized
   twin that must not.
3. **Adversarial before happy-path padding.** Hostile inputs, partial streams, mid-op
   abort, colliding tags, wrong cwd, denied approval, broken frames, unicode/CRLF.
4. **Assert truth, not shape.** Exact bytes, codes, ids, paths, counts. Ban
   `!is_empty()`, bare `not.toThrow()`, "something happened."
5. **Call shipped APIs.** Drive exported product functions. Do not re-implement the
   unit under test inside the test file.
6. **No theater.** No source-grep tests, no cases that exist only to raise counts, no
   random fuzz farms as the expansion strategy. Property/fuzz only when they encode a
   **named product invariant** with fixed seeds and real asserts.

A case ships only if you can name the contract in one sentence, assert exact values,
and it would fail if the engine returned empty success or the wrong file/frame.

## What a test must do

A test defends one **concrete, externally observable contract**, a behavior, output
shape, state transition, error mapping, or a regression-prone parsing boundary. If you
can't name the contract, don't add the test.

Assert real values. `expect(true).toBe(true)`, a bare `not.toThrow()`, a non-empty
check, or a "length grew" check proves nothing and is banned. Assert the file, line,
value, exit code, or output bytes that actually matter.

### Depth for shipped surfaces

For a user-visible or wire-visible surface, land all of:

1. **Positive truth** — exact expected values
2. **Negative twin** — sanitized case must not fire
3. **Boundary** — empty, max, EOF/BOF, unicode, CRLF/LF
4. **Adversarial** — hostile input, concurrent mutation, mid-stream abort, partial frames
5. **Cross-module** — real A → real B when the surface spans packages
6. **E2E** — real CLI/RPC when the surface is operator-facing

Complex multi-step paths (prompt → tool → steer → abort → resume, multi-file edit
batches, RPC id correlation) outrank more happy-path clones of the same function.
Named invariants (apply-then-inverse, id echo rules) beat volume.

## Isolation (required)

A test that only passes alone is broken. Suites that touch Settings, `process.env`,
`VEYYON_*`, profiles, agent dir, or project dir **must** use:

```ts
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(() => {
  settingsState = beginSettingsTest();
});

afterEach(() => {
  restoreSettingsTestState(settingsState);
  settingsState = undefined;
});
```

`restoreSettingsTestState` restores env, rebuilds dir state from env
(`__resetDirsFromEnvForTests`), re-applies agent dir / profile / project dir (and
`process.cwd()` via `setProjectDir`), clears the Settings singleton, and restores TUI
tight mode. Prefer this over hand-rolled `resetSettingsForTest` + partial env cleanup.

Spawned CLIs must use `hermeticSpawnEnv()` so children never read or migrate the
developer’s real `~/.veyyon`.

Contract tests for the helper itself live in
`packages/coding-agent/test/helpers/settings-test-state.test.ts`.

### Finding out which suite leaked

When a file passes alone and fails in a full run, the failure is on the victim and
the cause is in some earlier file. To find that file, run:

```sh
bun scripts/find-test-leaks.ts packages/utils/test          # a whole tree
bun scripts/find-test-leaks.ts packages/utils/test/profiles.test.ts
```

Each file runs in its own process with the leak tracer preloaded, and the script
prints what the file left changed:

```
packages/utils/test/install-id.test.ts
  left behind  env.VEYYON_CODING_AGENT_DIR: (unset) -> /home/you/.veyyon/profiles/work/agent
    first changed by test #1: env.VEYYON_CODING_AGENT_DIR
```

The verdict is per FILE. A suite may move `VEYYON_CONFIG_DIR` between its own tests
and restore it in `afterAll` — `logger-file-transport-rebind` does, because
following the move is what it tests — and that is not a leak. What breaks other
files is state still changed once the file is done, so that is what the script
reports. The per-test trail below each finding tells you where to look first.

Tracked state is the process-wide state that decides where files land. Two kinds:

- Environment and cwd: every `VEYYON_*`, `PI_*`, and `XDG_*` variable, plus `HOME`,
  `USERPROFILE`, `TMPDIR`, `NODE_ENV`, and the working directory.
- Module state in the resolver, reported with a `state.` prefix: the active profile,
  the resolved agent dir, the project dir, and the pre-profile agent-dir baseline.

That last one is worth knowing about, because it is invisible everywhere else. The
baseline is what `setProfile(undefined)` returns to, `setAgentDir` overwrites it, and
no variable or resolved path shows the change. A suite could restore the environment,
the profile, and the agent dir perfectly and still leave the baseline pointing inside
a temp directory it had already deleted; the next file anywhere in the process that
returned to the default profile would resolve there. Register new module state as a
probe in `packages/utils/test/helpers/global-state-leak-probes.ts` rather than adding
a special case to the tracer.

The trap most of the findings shared is worth knowing before you write a restore:
neither setter is its own inverse.

- `setAgentDir(dir)` WRITES `VEYYON_CODING_AGENT_DIR`, so restoring with
  `setAgentDir(theOriginal)` puts the resolver back and leaves the variable set. If
  it had been unset, the suite has just exported the developer's real agent dir to
  every file after it. It also CLEARS the active profile, so a suite that ran under
  a named profile hands every later file the default one.
- `setProfile(theOriginal)` WRITES `VEYYON_PROFILE` and exports the profile's agent
  dir, so restoring a profile that way leaves both variables behind — and every
  child process a later suite spawns inherits a profile nobody chose.

Use `enterIsolatedConfigRoot` or one of the file-level helpers above. Outside
`packages/coding-agent`, or for a suite that only pulls these two levers, use the
pair that owns the whole undo:

```ts
const dirOverrides = captureDirOverrides();   // from @veyyon/utils/dirs
afterEach(() => restoreDirOverrides(dirOverrides));
```

It restores both variables (including back to absent) and the in-memory active
profile, then rebuilds the resolver. Its contract is pinned in
`packages/utils/test/dir-overrides-restore.test.ts`.

Two file-level isolation helpers cannot be stacked. `afterAll` callbacks run in
REGISTRATION order, so the second helper's restore — whose snapshot was taken after
the first had already redirected the agent dir — puts that redirection back on the
way out. `claimFileLevelIsolation` refuses the combination with a message naming the
replacement: `useIsolatedAgentDir({ globalSettings: true })`.

One more ordering rule, from the same hunt: if a suite mocks `os.homedir()`, take
the mock OFF before restoring the overrides. Restoring rebuilds the dir resolver, and
rebuilding it while `homedir()` still answers with a temp path bakes that path into
every resolved dir for the rest of the process.

The tracer lives in `packages/utils/test/helpers/global-state-leak-tracer.ts` with
its `--preload` shim beside it, and its own contract tests are in
`scripts/find-test-leaks.test.ts`.

### A fixture that leaks on purpose must not be named `*.test.ts`

`scripts/find-test-leaks.ts` needs suites that genuinely leak, so
`packages/utils/test/fixtures/` holds three of them: one sets `VEYYON_CONFIG_DIR` and
never restores it, one activates a profile and leaves it active, and one restores
properly so the tracer can be shown not to cry wolf.

Name such a fixture `*.fixture.ts`, never `*.fixture.test.ts`. `bun test <dir>` collects
every name containing `.test`, `_test_`, `.spec`, or `_spec_`, at any depth, so a
fixture inside the glob runs in ordinary directory runs and poisons every file after it.
That is what made this repository's full-suite pollution look nondeterministic for weeks:
the victims were whichever suites happened to run after the fixture.

Drive a fixture by passing its path to `bun test`:

```sh
bun test ./packages/utils/test/fixtures/leaky-suite.fixture.ts
```

An explicit path runs the file whatever its name is. A path WITHOUT the leading `./` (or
an absolute prefix) is treated as a name FILTER instead, and a filter only matches files
discovery already found, so a `*.fixture.ts` target silently matches nothing. This is why
`traceFile` resolves the target to an absolute path before spawning.

`packages/utils/test/deliberate-leak-fixtures-are-not-collectible.test.ts` locks the naming
and keeps the fixtures honest, so the rename cannot be undone by accident.

### When the leak is not tracked state

`find-test-leaks.ts` reports the state it knows about: environment, cwd, and the dir
resolver. A leak outside that set — a module-level singleton, a spy nobody restored, a
timer still running — leaves no trace for it to find. For those, search by bisecting the
file list instead:

```sh
bun scripts/find-order-polluter.ts packages/coding-agent/test/victim.test.ts
bun scripts/find-order-polluter.ts packages/coding-agent/test/victim.test.ts --name "the one failing test"
```

The script proves two premises before it searches, and refuses rather than guess if
either fails: the victim passes alone, and it fails with a window of candidates in front
of it. The window GROWS rather than starting at the whole list: the last 64 files before
the victim, then 128, then 256, up to `--max-window` (200 by default). A leak reaches the
victim from just before it, so the window that reproduces is usually the first one, and
you get an answer in seconds instead of after a run of all 1,887 files. Reaching the cap
is reported as a refusal, never as "no polluter found". Then it halves the window, keeping
the half that still reproduces, and prints the file plus a two-file command you can run
yourself.

Do not add `--parallel=1` to it. The flag gives every file a fresh module registry, so
nothing leaks between files and the search finds nothing no matter what is wrong. The
script's header explains this and `scripts/find-order-polluter.test.ts` pins the behavior
against bun directly, so a future edit that adds the flag fails a test instead of quietly
returning clean answers.

Order is the part that needs care. Bun runs the files given on the command line in that
order, and a leak only reaches the victim from a file that ran BEFORE it — so the
candidate list, which defaults to name order, has to resemble the order the failing run
used. When the search refuses at premise 2, capture the real order from a junit report of
the failing run and feed it back:

```sh
bun test packages/coding-agent/test --reporter=junit --reporter-outfile=/tmp/order.xml
rg -o 'name="[^"]+\.test\.ts' /tmp/order.xml | sed 's/name="//' > /tmp/order.txt
# Only files that ran BEFORE the victim can pollute it, so cut the list there.
sed "/$(basename <victim>)/q" /tmp/order.txt > /tmp/order-prefix.txt
bun scripts/find-order-polluter.ts <victim> --order /tmp/order-prefix.txt
```

If neither half reproduces the failure on its own, the script says so and prints the
smallest set it still reproduces with: some failures need two leaks together, and naming
one file would be a guess.

Its own contract tests are in `scripts/find-order-polluter.test.ts`. They put their
fixture suites in the system temp directory rather than in the tree, because an identical
fixture pair leaks a module-level global reliably from outside the repository and
inconsistently from inside it.

### Assert every root, not the one you happened to redirect

An isolation assertion only proves the one path it names. This has now caused
three separate incidents, each with the same shape: a suite redirected one root,
asserted that root, passed for months, and wrote real user data through a
different root the whole time.

There are three roots, and they move independently:

| Root | What lives there | Lever that moves it |
| --- | --- | --- |
| Config root | settings, profiles, agent storage, `shared-auth/agent.db`, `gpu_cache.json` | `VEYYON_CONFIG_DIR` |
| Cache root | argot dictionaries and other regenerable caches | `XDG_CACHE_HOME` |
| Agent dir | one profile's storage inside the config root | `setAgentDir` |

Two traps follow from that table:

- `XDG_CACHE_HOME` moves the cache and nothing else. A suite that redirects only
  the cache still writes settings and agent storage to the real config root.
- `setProfile` and `setAgentDir` name a subdirectory of whichever config root is
  active. They do not move the root, so on their own they only change where under
  your real home the writes land.

So redirect what the code under test actually resolves, then prove each one:

```ts
process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
process.env.XDG_CACHE_HOME = path.join(tempCache, "cache");
__resetDirsFromEnvForTests();
setProfile(TEST_PROFILE);

// Proof, not intention. Check every root the code can reach, not just the first.
for (const [label, resolved] of [
  ["config root", path.resolve(getAgentDir())],
  ["cache root", path.resolve(getArgotCacheDir())],
] as const) {
  if (path.relative(tempRoot, resolved).startsWith("..")) {
    throw new Error(`${label} not isolated: ${resolved} is outside ${tempRoot}`);
  }
}
```

Run the suite bare (`bun test path/to/suite.test.ts`, without the runner) before
you trust it. The runner hands every child a sandboxed `HOME`, which hides a
missing redirect; running bare uses your real home and is the only way to see the
isolation actually hold.

## Real user data is off limits (three layers)

Your tests must never write to the real `~/.veyyon`. That directory holds working
OAuth credentials, settings, and session transcripts, and damaging it costs a real
person real logins. Three layers enforce this, and none of them require you to
remember anything.

### Why the obvious approach does not work

You will be tempted to isolate a suite like this:

```ts
beforeEach(() => {
  process.env.HOME = temporaryDirectory; // does nothing
});
```

Bun resolves `os.homedir()` once, when the process starts. Assigning
`process.env.HOME` afterwards changes the environment variable and nothing else,
so every config path still resolves under the real home. A suite that did exactly
this opened the real credential store and wrote three fabricated rows into it, and
every one of its assertions passed while it happened. `os.userInfo().homedir`
follows `HOME` too, so there is no in-process way back to the real home once it
has been redirected.

The levers that do work are:

- Set `HOME` in a **spawned** process's environment, which it reads before its own
  resolver runs. Use `hermeticSpawnEnv()` for this.
- Point the app's own override, `VEYYON_CONFIG_DIR`, at a temporary directory. It is a
  NAME joined onto the home directory, not a path that replaces it, so you pass a
  relative value that walks back out of the home: `path.relative(os.homedir(),
  tempRoot)`. An absolute value is refused, because it used to be joined anyway and
  quietly produce `~/tmp/your-temp-root`.
- Use `XDG_CACHE_HOME` and friends for cache and state paths.

Do not write that redirection by hand. There is one implementation of it,
`enterIsolatedConfigRoot(label)` in `packages/utils/test/helpers/isolated-config-root.ts`,
callable from any package and from a `beforeEach`. It puts the root under `os.tmpdir()`,
computes the relative value, refreshes the resolver, and clears `VEYYON_CODING_AGENT_DIR`,
which you will not think of and which outranks the config root outright when no named
profile is active: `setAgentDir` writes that variable and nothing clears it, so an earlier
suite's agent-dir isolation silently defeats your config root. For a whole file, use the
hook form `useIsolatedConfigRoot()` in
`packages/coding-agent/test/helpers/isolated-agent-dir.ts`, which wraps it.

Never isolate by inventing a fresh config-dir NAME (`.veyyon-<suite>-<id>`). It reads as
isolation and is not: the name is joined onto `os.homedir()`, so the tree lands in the real
home whenever the suite runs outside the test runner's sandboxed `HOME`, which is what a
bare `bun test path/to/file` does. That left 133 abandoned `~/.veyyon-*` directories in a
real home, and the real-data tripwire now refuses any write to a `~/.veyyon*` path so it
cannot happen again.

To give a whole package one convention, export a hook from its shared test setup and
call it in every suite, the way `useMnemopiTestEnv()` in `packages/mnemopi/test/setup.ts`
does. Export a FUNCTION; do not register `beforeEach`/`beforeAll` at the setup module's
top level. A shared setup module is imported once per test process, so hooks registered
at its module scope belong only to the suite that imported it FIRST. Every other file
importing it runs with no hooks at all, silently: mnemopi's module resets had that shape,
and eleven of the twelve files importing them were getting none.

Do not reach the other way either and enter a root at module scope without restoring it.
It survives past the package's own suites and leaks `VEYYON_CONFIG_DIR` into whatever
else shares the process. That was tried here, and it broke a utils test asserting the
config-root refusal message, which then reported a mnemopi temp path.

Restore in `afterAll` and the tree is removed for you. `process.once("exit", ...)` is not
an alternative: it does not run under `bun test`, so it is dead code that reads like
cleanup. As a backstop, `enterIsolatedConfigRoot` sweeps on its first use in a process,
deleting any temp root whose owning process id no longer answers, so a root abandoned by
a crashed run is reclaimed by the next one instead of accumulating.

For a suite that also needs `HOME` itself redirected, `enterTempHome()` in
`packages/coding-agent/test/helpers/temp-home.ts` applies both halves: `HOME` for the code
that reads it at call time, such as shell completion paths, and the config root that `HOME`
cannot reach. Its `restore()` puts every variable back as it found it and deletes the tree.

### Temp directories are collected for you

You do not have to remove the temp directories your suite creates. Every test process
preloads `packages/utils/test/helpers/temp-dir-janitor.ts`, which wraps `fs.mkdtemp`,
`fs.mkdtempSync`, `fs.promises.mkdtemp` and all three `mkdir` forms, records what each call
created, and removes those paths in an `afterAll` that bun runs at the end of every test
file. Removing them yourself is still welcome and still correct; it is simply no longer the
thing that stands between the suite and a full disk.

It records the path `mkdtemp` returned, never a path it guessed from a prefix, and only
when that path is inside `os.tmpdir()`. So a suite that points `mkdtemp` at a directory in
the repository keeps its output, and a directory belonging to another process is never
touched.

`mkdir` is recorded on the same terms, because most test files do not call `mkdtemp` at
all: they join a unique name onto the tmpdir themselves. What makes that safe is that
`mkdir` says whether it created anything. With `recursive: true` it returns the topmost
directory it made, or `undefined` when everything already existed; without it, the call
throws when the target exists. So the janitor claims a directory this process made and
never one it merely opened, and the topmost path is what gets recorded, so removal does not
leave empty parents behind.

One case is worth knowing about. If your suite creates a FIXED-name directory under the
tmpdir, such as a cache at `path.join(os.tmpdir(), "veyyon-my-cache")`, the file that
created it will remove it at the end of that file, while another test file running in
another worker may still be using it. A unique name cannot be shared and has no such
hazard, so prefer `mkdtemp`; if you do need a shared fixed name, make the code that reads it
recreate it on demand.

When it cannot remove something, it says so, on stderr, naming the path and the reason:

```
temp-dir-janitor: 1 scratch directory could not be removed and is left behind:
  /tmp/veyyon-example-a1b2c3: EACCES: permission denied, rm '/tmp/veyyon-example-a1b2c3'
```

Treat that line as a finding rather than noise. It is the only signal that a run left
something on disk, and the hook deliberately does not throw: teardown runs after the last
test, so a throw there is attributed to whichever file finished last and blames the wrong
suite. The message was absent for a while, because the hook called the removal and threw
away its report, which meant a directory it could not collect was left behind with nothing
anywhere naming it. `temp-dir-janitor-reports-what-it-cannot-collect.test.ts` pins it.

Two cases the recording cannot see, both of which you own:

- A directory another process created that yours only reopens. Nothing in your process made
  it, so nothing collects it.
- A process killed with `SIGKILL`, which runs no hook at all.

### Do not add per-suite temp cleanup by default

The janitor is the one owner of this. A new suite should call `mkdtemp` and stop there: an
`afterAll` that removes what the janitor already removes is a second mechanism for one job,
and the two drift the moment somebody changes one of them.

This is worth stating because it has been got wrong once already, by reading a leak on a
developer's disk as a missing `afterAll` and adding one to thirty-odd files. Two things made
that reading look right and both are traps. The first is that a suite calling `removeWithRetries`
in an `afterEach` does not match a grep for `rmSync`, so a file that already cleans up reads
as a file that never did. The second is that `/tmp` on a working machine holds directories
from months of runs, including runs from before the janitor existed, so its contents say
nothing about whether today's run leaks. Measure a single run instead: list `/tmp/veyyon-*`
before and after and `comm` the two.

Write cleanup yourself only when the directory has to be gone BEFORE the file ends, which is
rare, or when the tree is not under `os.tmpdir()` and so is outside what the janitor will
touch. `packages/coding-agent/test/helpers/tracked-temp-dir.ts` is there for those cases:
`useTrackedTempDirs(prefix)` returns a factory that registers its own removal, and
`useTrackedTempDirFactory()` is the same thing for a suite that names each directory after
the case that made it.

For both, `scripts/ci-test-ts.ts` sweeps before a run: for every prefix in
`TEST_TEMP_DIR_PREFIXES` it removes matching directories in `os.tmpdir()` that nothing has
written to for six hours. Six hours is longer than any run here, so the sweep can only ever
reach scratch whose owner is gone, and it reports what it removed rather than doing it
quietly.

The prefix list matters more than it looks. It held `veyyon-` alone while `/tmp` carried
14,364 `pi-` directories from the coding-agent suite, so the sweep ran, reported a clean
reclaim, and left the larger half of the stranded scratch on disk. If you introduce a new
prefix, add it there. Keep it distinctive: the sweep identifies another process's leftovers
by name and age, so a generic prefix such as `test-` would reach directories that are not
ours.

This exists because it was once absent. `/tmp` accumulated 38,600 stranded `veyyon-*`
directories totalling 240 GB and the root filesystem reached 100% full with 18 MB free, at
which point nothing on the machine could build or test. 233 test files call `mkdtempSync`
across 405 call sites and 102 of them never removed anything, so a single full run leaked
over 1,700 directories. The largest were around 290 MB each: a CLI spawned with a fresh
`HOME` stages the native addon into that home.

### Layer one: every test child gets a disposable home

`scripts/ci-test-ts.ts` spawns each test process with `HOME` pointing at a fresh
temporary directory, and passes the real config root down in
`VEYYON_TEST_REAL_CONFIG_ROOT`. Because config, credential, and session paths are
all built from `os.homedir()`, a child started this way cannot name real data at
all. This applies to the whole suite without any suite opting in.

### Layer two: the tripwire refuses the write

`packages/utils/test/helpers/real-data-tripwire.ts` is loaded as a `preload`, so it
runs in every test process before any test module. It throws on any attempt to
modify a path inside the real config root, naming the path and explaining the trap
above.

Bun reads `bunfig.toml` from the current directory only, so the preload is
delivered three ways: the root `bunfig.toml` for runs at the repository root, a
one-line pointer in each package's `bunfig.toml` for runs inside a package, and an
explicit `--preload` on every command the runner spawns. Only the pointer repeats;
the tripwire itself has one home.

If you add a package that has tests, add its `bunfig.toml` pointer at the same
time. A package without one runs its whole suite unguarded as soon as anyone runs
`bun test` from inside it, which is how most suites are run while working.
`packages/utils/test/tripwire-preload-coverage.test.ts` fails when a package with
test files has no pointer, when a pointer names a file that does not exist, and
when a second copy of the tripwire appears anywhere under `packages/`.

Bun does not read `.gitignore` when it looks for tests, so any directory holding
cloned third-party repositories has to be pruned explicitly through
`pathIgnorePatterns`, in the root config and in that package's own config. The
deepswe benchmark's `repo-cache/` is the case that exists today: 113 upstream
projects with their own suites, which a sweep will otherwise collect and fail on
dependencies this repository does not install.

It covers what prevention cannot: a hardcoded absolute path, a suite that restores
the real `HOME` in `afterEach`, and a bare `bun test path/to/file`. It wraps
mutating `node:fs` calls and also `bun:sqlite`, because the original damage went
through SQLite's native file handling and never touched a single `fs` function.
Reads are allowed, since reading real data is at worst untidy.

If you trip it, fix your test. Do not weaken the tripwire.

Note that the patch rewrites the `node:fs` exports, so it only binds for modules
that import `fs` after it loads. If you write a test that deliberately probes a
real path, check `__tripwire.isGuarded(fs.writeFileSync)` first and refuse to probe
when it is false. Otherwise a late-loaded tripwire turns your probe into the very
write it was meant to prevent.

### Layer three: the runner proves nothing changed

Before the suite runs, the runner records every file under the real config root
with its size and modification time, and checks again afterwards. Any created,
modified, or deleted file fails the run and names the paths, even when every test
passed, because a green suite that damaged real credentials is the worst possible
outcome to report as success.

Logs, session transcripts, and caches are excluded, since a veyyon session you have
open writes to them constantly and reporting that would train everyone to ignore
the check. What stays watched is the surface whose loss is unrecoverable:
credential stores, the global config, the install id, and the per-profile
databases.

### Writing a suite that touches app paths

Isolate through `VEYYON_CONFIG_DIR`, then verify the path the app actually resolved
before you write to it:

```ts
import { assertIsolatedAppPath } from "@veyyon/utils/test/helpers/destructive-guard";

process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), temporaryRoot);
__resetDirsFromEnvForTests();
assertIsolatedAppPath(getAgentDir(), "my-suite");
```

Guard the resolved value, not the value you expected. The difference between those
two is the entire incident.

## Running the suite without melting the machine

The runner is sequential by default: one chunk at a time. Each chunk is a
`bun test` process that spawns children of its own, so fanning out to every core
multiplies into hundreds of processes and drove the load average past 80 on a
workstation, making it unusable while the run proceeded. If you want fanout, ask
for it explicitly with `VEYYON_TEST_CONCURRENCY=8` (or `all`), and prefer that on a
machine you are not using for anything else.

### What a full run's memory is actually made of

A full run of `packages/coding-agent/test` is killed by the kernel at about 13.4 GB when it is run
with `--parallel=1`. The flag is the reason, so start there before you go looking for a leak. The
same 1,887 files run to completion under bun's default parallelism, peaking at 2.31 GB across the
whole process tree, so "nobody can run the suite locally" is true only of the serial mode.

**The two run modes have completely different memory behavior.** Bun's default runs test files in
worker processes and recycles them, so what a file retains dies with its worker. `--parallel=1` runs
every file in one process, so what a file retains is held until the run ends. The same 60 files peak
at 0.76 GB by default and at 4.62 GB with `--parallel=1`, and the same eight probe files peak at
0.16 GB by default and at 0.52 GB with the flag. A ceiling measured in one mode tells you nothing
about the other.

**Under `--parallel=1`, every test file gets a fresh module registry.** This is the mechanism behind
everything else in this section, and it is the opposite of what the flag sounds like. Write a module
with a counter, import it from two test files, and the second file sees the counter at one and the
first file's writes absent. At the default parallelism the second file sees what the first left,
because files that land in the same worker share its realm. So `--parallel=1` does not mean "one
shared process"; it means "one process, one realm per file, and every realm kept". Two consequences
that matter more than the memory:

- Order-dependent failures do NOT reproduce under `--parallel=1`. Nothing leaks between files, so a
  search for the polluter finds nothing and reports the suite clean. `scripts/find-order-polluter.ts`
  therefore runs at the default parallelism on purpose, and its header says so at the top.
- The retained realms are the memory. One per file, about 76 MB each.

**So workspace source is re-instantiated for every test file.** Measure it with a
`--preload` that reports `process.memoryUsage.rss()` from an `afterAll`, which bun runs after each
file, over N probe files that differ only in their test name. RSS in MB after each of eight files:

| probe | series |
| --- | --- |
| no imports | 41 44 45 47 49 51 52 54 |
| `arktype` from `node_modules` | 106 127 144 163 166 170 170 173 |
| `@veyyon/coding-agent/sdk` | 260 335 387 431 485 540 593 647 |
| `session/agent-session` | 232 286 343 388 427 475 522 564 |

The `node_modules` package flattens, so that graph is instantiated once and cached. Workspace source
does not flatten: it is a straight line at 47 to 56 MB per file with no sign of settling. Across the
first 60 real files of the sorted suite the slope is 75.8 MB per file, and 1,887 files at that slope
is about 143 GB, which is the kill you see.

Three things it is NOT, each measured so you do not spend a day on them:

- Not collectable garbage. `Bun.gc(true)` in the same `afterAll` reclaims none of it (643 MB without
  it, 672 MB with it, over the same eight files). The graphs are rooted.
- Not the specifier form. `../../src/session/agent-session` and
  `@veyyon/coding-agent/session/agent-session` give the same series to within one percent, so it is
  not `exports` or symlink resolution producing two cache keys.
- Not one bad file. The per-file cost is close to uniform across the 60 files measured.

So under `--parallel=1` the cost really is per-file graph size times file count, and trimming what a
test file imports reduces it directly. Under the default it does not, because the union one worker
holds is bounded: every test file in the package together reaches 1,902 distinct source modules.
Retained state (sessions, opened databases, temp workspaces, registered listeners, module-level
caches that grow as file after file adds entries) is worth fixing on its own terms and is what would
show up in a default run, but it is not what the `--parallel=1` kill is made of. `BACKLOG.md` carries
the open row.

**The gate.** `scripts/check-test-memory.ts` takes both measurements over a fixed sample of 60 files
and fails when either ceiling is exceeded. Run it yourself with `bun run scripts/check-test-memory.ts`,
or with `--report` to print both numbers and assert nothing. It runs nightly in `.github/workflows/leak-sweep.yml` rather than per commit, because it runs the
sample twice and each run takes minutes. `scripts/check-test-memory.test.ts` pins the arithmetic:
the slope is least squares over one process's series, not `(last - first) / n`, so a single file that
allocates and frees does not become the trend, and the peak is per process, so four workers are never
added into one worker's number.

Two things that are still worth doing, for reasons other than the total:

- **Import from the leaf that owns the symbol.** A file that pulls a barrel for one symbol makes the
  dependency graph say something false about what it depends on, and it makes an import cycle easy
  to create by accident. `validateRelativePath` cost 378 modules that way and `namespaceSessionId`
  510. This is an architecture argument, not a memory one.
- **Keep the hot entry points from growing without anyone noticing.** `no-import-cycles.test.ts`
  caps how many modules a named entry point reaches; add an entry when a module becomes something
  many suites import. `test-suite-module-reach.test.ts` caps the suite's total reach and how many
  files are individually heavy. Read the header of that file before treating either number as a
  memory prediction: it says plainly what the numbers do and do not mean.

**Every one of these ceilings is an upper bound, so a gate that resolves LESS passes.** This is the
one failure mode to understand before you write or edit one. A specifier the walk cannot resolve
contributes nothing: the walk stops there, the count comes back smaller, and the assertion holds
while measuring a graph smaller than the one that ships. It is not hypothetical. Four gates each
carried a hand-written list of workspace packages, and two of them listed `@veyyon/agent`, which is
not the name of any package here: the directory is `packages/agent` and the package is
`@veyyon/agent-core`. Every one of the 569 imports of it resolved to nothing, and so did
`@veyyon/mnemopi`, `@veyyon/stats`, `@veyyon/natives` and `@veyyon/tool-render`.
`packages/coding-agent/src/thinking.ts` was pinned at 12 modules with a comment calling it "nearly a
leaf"; it was 407, because it named the `@veyyon/agent-core` barrel.

So do not write that list. `workspaceModuleReachResolution(repoRoot)` from
`@veyyon/utils/module-reach-workspace` derives it from every package's `exports` field, and
`packages/utils/test/module-reach-workspace.test.ts` asserts that no workspace package is missing
from it. Pass a `createModuleReachCache()` when your gate walks many entries over one graph: the walk
re-reads each file otherwise, and the suite-total gate went from minutes to about a second with one
shared memo.

Two mechanical rules, both easy to get wrong:

- **`import type` is free; `import { type X }` is not.** A statement that begins `import type` is
  erased, so it costs nothing at runtime and neither ratchet counts it. The inline form still emits
  the import and still instantiates the module. When you remove the last value specifier from a
  mixed clause, convert the whole statement to `import type` rather than leaving the inline markers
  behind.
- **Reach for the package that OWNS the value, not the one that re-exports it.** `Effort` is
  declared in `@veyyon/catalog/effort`, a module of about ten lines, and `@veyyon/ai` re-exports it
  through `types.ts`. Twenty-eight test files imported it from `@veyyon/ai` and named a 300-module
  barrel for a string enum. Importing `@veyyon/catalog/effort` names one module and says what the
  file actually depends on.

Before assuming a package's importers need its barrel, list them: most files that name a package are
naming it for a type, and those already cost nothing. Of the 262 test files that mention
`@veyyon/ai`, only 74 import a value from it.

## Fixtures and regression corpus

Prefer data-driven cases over copy-pasted `it` bodies. Closing a bug should add a
**corpus row** (or a dedicated regression suite that asserts exact values), not only a
narrative comment.

| Location | Use |
| --- | --- |
| `packages/coding-agent/test/corpus/regressions/*.json` | Named contract rows `{ id, contract, surface, tags, input, expect }` |
| `packages/coding-agent/test/corpus/regressions.runner.test.ts` | Dispatches rows to shipped APIs |
| `packages/coding-agent/test/helpers/corpus-loader.ts` | Load/validate corpus (rejects missing expect / weak contract text) |
| `packages/<pkg>/test/fixtures/` | Local JSON/JSONL/TOML tables for one package |
| `packages/coding-agent/test/helpers/integration-workspace.ts` | Multi-file trees for edit/grep/glob/hashline: a REAL temp workspace driven through the real agent loop, not a checked-in tree |
| `packages/coding-agent/test/helpers/subagent-session.ts` | The fake `AgentSession` a `runSubprocess` test spawns, plus the message and yield-event builders |
| `packages/hashline/test/*` | Model for pure contract + adversarial multi-file suites |
| `packages/coding-agent/test/rpc-command-contracts.test.ts` | RPC frame id/parse/background contracts (no provider keys) |
| `crates/*/tests/fixtures/` | Shared inputs for native crate tests |

Corpus row requirements: non-empty `id`, a real one-sentence `contract`, a `surface`
the runner knows, and exact `expect`. Shape-only rows fail at load time.

Name files and ids for the **behavior** (`list-limit-equals-ceiling`,
`rpc-unknown-command-drops-id`), never for an implementation strategy or port.

### Testing a subagent run

`runSubprocess` runs an agent in-process. It calls `createAgentSession`, prompts the
session, and reads the session's EVENTS to decide what happened, so a test drives it by
deciding what the child emits. Use the shared fake rather than writing another session
literal:

```ts
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/subagent-session";

const session = createMockSession(({ emit }) => {
	emit(yieldSuccessEvent({ ok: true }));
});
vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

const result = await runSubprocess(options);
```

The callback runs on every `prompt`, and its `promptIndex` tells you which one, so you can
answer the task and a later reminder differently. `pushTurn(message)` pushes a message and
emits its `message_end`, which is the pair the request accounting counts.

When a test needs to observe how the executor drove the child, call
`createMockSessionHandle` instead: the handle carries the prompts it received, the steering
notices it was sent, and the abort and dispose counts. Reach for an option only when a
specific executor read depends on it, and each option's doc comment says which read that
is. Two examples: `hangUntilAbort` makes `prompt` and `waitForIdle` wait for an abort, which
is how a stalled provider stream is modelled for the wall-clock and hard-budget guards, and
`argotSession` gives the child a loaded codec, which is what the return boundary expands
handles through.

Every suite that drives `runSubprocess` uses this helper. Adding a member to a private copy
instead means the next executor change breaks a fake nobody knows about, which is how a
missing `yield` handler once surfaced as seventeen unrelated-looking failures.

## Suite map (where contracts live)

| Domain | Primary home |
| --- | --- |
| Hashline parse/apply/recovery | `packages/hashline/test/` |
| Agent loop / compaction | `packages/agent/test/` |
| Provider streams / codecs | `packages/ai/test/` |
| Catalog identity | `packages/catalog/test/` |
| Session orchestration | `packages/coding-agent/test/agent-session-*.test.ts` |
| Tools | `packages/coding-agent/test/tools/`, `test/core/` |
| RPC / SDK | `packages/coding-agent/test/rpc*.ts`, `sdk-*.test.ts` |
| Settings | `packages/coding-agent/test/settings*.test.ts` + helper |
| TUI | `packages/tui/test/`, `coding-agent/test/modes/` |
| Natives | `packages/natives/test/`, `crates/veyyon-*/` |
| Install / binary smoke | `scripts/install-tests/`, `veyyon --smoke-test` |
| Install per environment | `scripts/installer-environment-matrix.test.ts` + `scripts/install-tests/environments.toml` |
| Update per environment | `scripts/update-environment-matrix.test.ts` (same TOML, shared harness) |
| Regression corpus | `packages/coding-agent/test/corpus/regressions/` |

## Installer gates per platform

The installer is a shipped product surface on three platforms, and each one has
its own gate:

| Platform | Gate | What it drives |
|---|---|---|
| Linux, macOS | `scripts/install-tests/run-ci.sh` (CI job `install_methods`, matrixed over `ubuntu-22.04`, `macos-14` and `macos-15-intel`) | `install.sh --local` end to end: install, reinstall, uninstall, plus the no-clobber rules for a `vey` the user already owns |
| Linux, macOS, on push to main | `scripts/install-tests/published-release-e2e.sh` (CI job `install_binary_posix`) | `install.sh` with no mode: the release lookup, the download and the `.sha256` check, which is what `curl \| sh` does |
| Linux | `scripts/installer-environment-matrix.test.ts` | `install.sh --local` once per shell/XDG combination in `environments.toml` |
| Linux | `scripts/update-environment-matrix.test.ts` | A real binary swap and completions refresh over each of those same installs |
| Any | `scripts/posix-shell-portability.test.ts` | The one bash 3.2 incompatibility that only shows up on macOS, linted rather than executed |
| Windows | `scripts/install-tests/e2e.test.ps1` (CI job `install_ps1_e2e`) | `install.ps1 -Local` end to end: install, reinstall, reinstall over a quoted PATH entry, uninstall |
| Windows, on push to main | `scripts/install-tests/e2e.test.ps1 -Mode Binary` (CI job `install_ps1_binary`) | The same run against the newest published release, which is the default install |
| Windows | `scripts/install-tests/functions.test.ps1` (CI job `install_ps1_functions`) | The pure helpers, with nothing installed |
| Linux, by hand | `scripts/install-tests/stress.sh` | Real downloads in ~44 adversarial environments, in a disposable container |

`run-ci.sh` and `published-release-e2e.sh` drive the same assertions from
`scripts/install-tests/installer-e2e-lib.sh` and differ only in the mode they hand
`install.sh`. Two copies would drift, and the copy that drifts is the published-release
one, because it runs on fewer commits and is the one users actually get.

The Windows end-to-end test edits the user PATH and the CurrentUserAllHosts
PowerShell profile for real, because the installer does and testing a fake would
prove nothing. It captures both before the run, asserts what the uninstall
reclaimed, and restores them in a `finally` block. It refuses to start unless
`VEYYON_INSTALL_E2E=1` is set, so running the suite on your own machine cannot
edit your PATH by surprise:

```powershell
$env:VEYYON_INSTALL_E2E = "1"; pwsh -File scripts/install-tests/e2e.test.ps1
```

`-Mode Binary` runs the identical assertions against the install a user actually
gets: the release lookup, the download and the `.sha256` verification, rather
than a binary the checkout already built. It is push-to-main only, because it
downloads a published release every time and needs one to exist.

One of its cases rewrites the PATH entry into the quoted form Windows tools use
around a path containing a space, then reinstalls. That is the shape the
installer used to fail to recognize as its own, and it is invisible to a test
that only ever sees the entry it wrote itself.

`-Local` on Windows is the counterpart of `--local` on Linux and macOS: it
installs the binary the checkout has already built rather than downloading a
release, which is what lets the real installer run in CI with no published
release and no network.

## The adversarial install matrix

`scripts/install-tests/stress.sh` asks a different question from the gates above.
Those prove the install works in the environments it was written for; this one
puts it in environments nobody designs for and reports what breaks. It drives
about 44 cases: three shells, four hostile `$HOME` names, three terminal widths
plus a terminal with no width tools at all, a read-only install directory, a
read-only rc, a full disk, a shadowed `PATH`, two concurrent installs, a SIGINT
mid-copy, a killed installer's staging file, a missing `$HOME`, six hostile
environment variables, two umasks, a symlinked install directory, a tampered
download, a missing release, a `--ref` spelled without its leading `v`, a machine
with no curl installed, no network at all, a double uninstall, a reinstall
over a running install, and the three things a second install is most likely to
get wrong: a duplicated `PATH` entry, completions that an uninstall left behind
or a reinstall failed to rewrite, and a doctor that warns because the previous
install is still partly there.

It is not in CI and not in `bun test`. It performs real installs, including real
downloads of a 300 MB binary, and several cases deliberately break the machine
they run on: they make directories read-only, kill installers mid-copy, and
tamper with a downloaded file. Run it in a container you are willing to throw
away:

```console
$ docker run -d --name veyyon-stress ubuntu:24.04 sleep infinity
$ docker exec veyyon-stress bash -c 'apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    curl ca-certificates dash bash util-linux ncurses-bin && useradd -m tester'
$ docker cp scripts/install.sh veyyon-stress:/home/tester/install.sh
$ docker cp scripts/install-tests/stress.sh veyyon-stress:/home/tester/stress.sh
$ docker exec -u tester veyyon-stress bash /home/tester/stress.sh
```

A case that cannot run in your container reports `SKIP` and is counted
separately. A skip is never counted as a pass, because a skip counted as a pass
is the same defect the matrix exists to find in the product.

When a case fails, fix the installer and then encode the failure where it will be
checked on every commit: an environment goes in `environments.toml`, and a
behaviour goes in `scripts/install-tests/functions.test.sh`. The matrix finds
things; it is not where they are locked down.

## Adding an environment to the install matrix

`scripts/installer-environment-matrix.test.ts` runs `sh scripts/install.sh --local` for
real, once per case in `scripts/install-tests/environments.toml`, inside a `$HOME` that
exists only for that case. Every case gets the same assertions: exit 0, the binary in
place byte-identically and executable, `vey` pointing at it, the PATH line in exactly
the rc that shell reads and in no other, every pre-existing byte of that rc preserved,
the completion files at the paths the case's XDG variables imply, doctor's native
self-test passing, no staging file left behind, and a second run changing nothing.

To cover a new environment, add a case to the TOML. You do not touch the test:

```toml
[[case]]
name = "fish uses fish_add_path in config.fish"
shell = "/usr/local/bin/fish"
home_dir = "fish-default"
install_dir = ".local/bin"
expect_rc = ".config/fish/config.fish"
expect_completions = [".config/fish/completions/veyyon.fish"]
```

`pre_files` seeds files under the disposable `$HOME` before installing, `pre_symlinks`
seeds links (a `$HOME` in either is expanded), `expect_absent` lists paths that must not
be created, `install_dir_on_path` puts the install directory on `$PATH` so the
installer has nothing to add and must leave every rc alone, and
`alias_is_foreign` says the case seeds a `vey` in the install directory that the
installer did not create, which inverts every assertion about our own alias: the file
must survive install, reinstall, update and rollback byte for byte, and our completion
scripts must stop binding the name. That last part is the half that is easy to miss,
because declining to write the alias FILE leaves our own script completing both names
and handing our subcommands to their tool. `expect_rc_stays_symlink` asserts the rc is
still a symlink afterwards and that the PATH
line landed in the file the link points at. That last one is the case a dotfile manager
produces: rc files are symlinks into a repository, and an installer that appends by
replacing the link with a regular file silently detaches the user's dotfiles from their
repository.

The installed binary is a stand-in script rather than the compiled `veyyon`: what is
under test is the installer's handling of the environment, and a 100 MB build per case
would make the matrix unrunnable. The stand-in cannot silently fall behind, because one
test reads the probes back out of `install.sh` and fails if the installer starts asking
the binary for something the stand-in does not answer.

### Writing sh that survives macOS

macOS `/bin/sh` is bash 3.2, and one of its incompatibilities has already turned both
macOS gates red. Inside a command substitution, bash 3.2 reads the `)` that ends a
`case` pattern as the `)` that ends the substitution, so a line of valid POSIX sh dies
at run time with `syntax error near unexpected token 'newline'`. Nothing on Linux sees
it: `sh -n` passes, `dash` passes, and the branch only has to be reached on a macOS
runner for the whole file to fall over.

Write the pattern with a leading `(`, which every shell accepts:

```sh
check "the hint names the rc file" "$( case "$hint" in (*.zshrc*) echo yes ;; (*) echo no ;; esac )"
```

`scripts/posix-shell-portability.test.ts` keeps them there. It is a lint rather than an
execution test because reproducing the failure needs bash 3.2, which the Linux runners
cannot install, so the choice is a lint or nothing.

## The update matrix runs on the same environments

`scripts/update-environment-matrix.test.ts` takes each install the matrix above
produced and updates it, so the same TOML covers both halves of the product. An
update is where an environment does its damage quietly: the binary swap succeeds and
reports the new version, and what breaks is everything around it, an rc the updater
touched, a second PATH entry, a `vey` link left pointing at the file that was replaced,
or completion scripts still describing the previous version in a shell whose completion
directory the updater resolved differently from the installer.

Both suites share one harness, `scripts/install-tests/environment-matrix-harness.ts`,
which owns the case type, the stand-in binary, the disposable `$HOME`, and the install
run. Neither suite names a shell or an XDG variable, so adding an environment is still
one TOML edit and it covers the update too.

The update runs the shipped `replaceBinaryForUpdate`, `refreshCompletionsForInstalledBinary`
and `sweepStaleBackups` for real, in a CHILD process carrying the case's environment.
The child is not a convenience: the completion paths are resolved from `process.env`
when the module runs, so a child started with the case's `HOME` and `XDG_*` is the only
way to ask where THAT environment's completion files live rather than where this
machine's are.

After every case: the binary is the new version's bytes and still executable, the rc
is byte-identical to what the install left (an updater has no business editing it),
the install directory holds exactly one entry on `$PATH`, `vey` still resolves to the
binary, every completion file the install wrote has been rewritten from the NEW binary,
and the sweep leaves no backup or staging file behind.

Each case then rolls BACK to the version it started on, which is the same swap with an
older target because `veyyon rollback` reaches it through `installRelease`. The
completion files have to become byte-identical to what the install wrote, which is
stronger than "they no longer name the newer version": a rollback that regenerated from
the wrong binary would also stop naming it. That second swap is also where litter
accumulates, so the install directory is checked again afterwards.

## Waiting for a TUI frame

A suite that drives a real `TUI` against a `VirtualTerminal` has to wait for the
frame before it asserts on the screen. Ask the engine, do not guess:

```ts
import { settleFrames } from "../../tui/test/helpers/settle-frames";

rows.setLines(["status-after"]);
tui.requestRender();
await settleFrames(term, tui);
expect(view(term)[0]).toBe("status-after");
```

`settleFrames` pumps timers until `tui.renderPending` is false (no frame is
requested, throttled, or held by a quiet window) and the engine's observable
state has stopped moving. It throws with the last state if frames never stop,
because an engine that keeps re-rendering is a defect and a quiet return would
surface later as an unrelated assertion failure.

Two older shapes are banned, and both shipped real flakes that only failed in a
full sweep and read exactly like regressions:

- **A fixed sleep.** `await Bun.sleep(40)` is a bet that the throttled frame
  arrives in 40 ms. Under sweep load it does not, and `overlay-scroll` read
  `"status-before"` one frame after setting the text to `"status-after"`.
- **Sampling counters until two samples match.** That is indistinguishable from
  an engine that has not started: nothing changed because nothing has happened
  yet. The pinned-composer suite froze a view under that rule and three
  still-queued wheel events then moved it.

Suites with a fake scheduler they step by hand (`StressRenderScheduler`) do not
use `settleFrames`; they drain their own scheduler, which is exact by
construction.

## Anti-patterns (these fail review)

- **Source-grep tests.** A test that reads an implementation file and asserts on its
  *text* (`expect(src).toContain("someCall()")`, `.not.toContain("oldName")`, "the
  comment says X") tests how code looks, not what it does. Assert the observable
  contract instead; enforce structural invariants with a type test or a lint rule.
- **`mock.module()`.** It mutates the global module registry and leaks across files
  ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the
  imported module object, with `vi.restoreAllMocks()` in `afterEach`.
- **Full-suite-unsafe mutation.** No long-lived changes to `Bun.*`, `process.platform`,
  `process.env`, or `Bun.env` when a narrower `spyOn` seam exists. A test that passes
  alone but poisons later files is broken.
- **Weakening a test to make it pass.** A failing contract test is a finding about the
  code, not the test. Fix the code.
- **Duplicated coverage.** If an integration test already proves the behavior, drop the
  narrower unit test that restates it through mocks.
- **UI chunk bloat.** Do not force more UI suites into one process than the bucket’s
  chunk size allows (ghostty GC aborts).
- **Volume theater.** Do not add cases to raise counts. Prefer one adversarial twin over
  a hundred random inputs with weak asserts.
- **Re-implementing the unit under test.** Drive the shipped export; the corpus runner
  is a dispatcher, not a second engine.

## Depth by risk

Scale coverage to what the code does. A shipped rule or user-visible surface wants the
positive case, a negative twin, adversarial/boundary inputs, and an e2e path when the
surface is operator-facing. A tiny low-risk change doesn't need a test unless it
protects a real contract or fixes a regression-prone edge.

Wiring you can't exercise in-process (worker spawn, install flow) is covered by the
runtime smoke probe (`veyyon --smoke-test`) and the install-test scripts, not by a
source grep.

*Verified against `cc919bad` on 2026-07-27.*
