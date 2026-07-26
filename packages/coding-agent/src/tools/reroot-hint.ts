/**
 * Noticing that the session is working somewhere other than its working
 * directory, and saying so once.
 *
 * WHY THIS EXISTS. `set_cwd` re-roots the session, which makes read/edit headers
 * relative instead of absolute and loads the destination project's `AGENTS.md`.
 * Both matter, and neither happens unless something calls the tool. Nothing did,
 * reliably: the only text describing when to re-root lived in the tool's own
 * description, and `set_cwd` is a `discoverable` tool, so it is not in the initial
 * toolset. A model that has not gone looking for the tool has never read the
 * advice, and a model that has not read the advice does not go looking. Asking it
 * to notice on its own is asking it to infer a policy from an absence.
 *
 * So the harness notices instead. Every filesystem tool call already declares its
 * targets for the cwd boundary; this watches those targets and, once a directory
 * outside cwd has been touched enough times to be the real subject of the session,
 * appends one short line to that tool's result. Deterministic input, deterministic
 * trigger, delivered where the model is already reading.
 *
 * IT MUST NOT NAG. A hint that repeats is worse than no hint: it burns context on
 * every call and trains the model to skim past it. Each directory is mentioned at
 * most once, the session emits at most {@link MAX_HINTS} in total, and a directory
 * the model has already re-rooted into can never be suggested because it stops
 * being outside cwd.
 */

import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { errorMessage, logger, trimTrailingSlashes } from "@veyyon/utils";
import { repo } from "../utils/git";
import { hasFilesystemTargets } from "./cwd-boundary";
import { isPathWithinCwd, resolveToCwd, splitPathAndSel } from "./path-utils";

/**
 * Distinct files under one directory before it is worth mentioning.
 *
 * Two is a coincidence: reading a config file and a type declaration from another
 * project while working here is ordinary and re-rooting for it would be wrong.
 * Three files in one place is a pattern, and by then the absolute paths in every
 * header have already cost more than the hint will.
 */
export const REROOT_FILE_THRESHOLD = 3;

/**
 * Distinct files under one directory before it is worth mentioning, when the session is rooted
 * somewhere that is not a project at all.
 *
 * One, because the evidence the normal threshold is gathering has already been supplied. Three
 * files exist to tell "the work has moved" apart from "a file was read in passing", and that is a
 * real question when the session is properly rooted in a project. It is not a question when the
 * session is sitting in `$HOME` or on a mount point: there is no project here for the read to be
 * incidental TO, so the first file touched anywhere else is the work. Waiting for two more means
 * the first several calls are all paid at full absolute-path price for nothing.
 */
export const MISROOTED_FILE_THRESHOLD = 1;

/**
 * The name of the re-root tool, owned here because this is the module that has to
 * NAME it in prose and ACTIVATE it, and `set-cwd.ts` is far too heavy to import
 * from a leaf that every tool call passes through. `SetCwdTool.name` and the
 * renderer read it from here, so the string the hint prints and the string the
 * model can call are the same string by construction.
 */
export const SET_CWD_TOOL_NAME = "set_cwd";

/**
 * Ancestors credited for each touched file.
 *
 * A file at `<root>/packages/thing/src/a.ts` should be able to nominate `<root>`,
 * not only its immediate directory, because the project root is what a user means
 * by "work over there". The cap keeps a deeply nested path from nominating `/`,
 * which is never a useful suggestion and would let files from unrelated trees
 * accumulate against the same bucket.
 */
const MAX_ANCESTOR_DEPTH = 6;

/** Hints one session will ever emit, after which it stays quiet for good. */
export const MAX_HINTS = 2;

/**
 * Entries that mark a directory as the root of a project.
 *
 * `.git` is listed first and treated as decisive by {@link resolveProjectRoot}, because a
 * repository boundary is the strongest available statement that everything inside it is one
 * project. The manifests are the answer for a directory that is not itself a repository, most often
 * a checkout inside a larger tree.
 *
 * `AGENTS.md` earns its place for the same reason the hint mentions it: the payoff of re-rooting is
 * that the destination's rules load, so a directory carrying rules is a project boundary by this
 * agent's own definition even when it carries no manifest.
 */
export const REPOSITORY_MARKER = ".git";

/** Root markers other than the repository boundary. */
export const MANIFEST_MARKERS = [
	"Cargo.toml",
	"package.json",
	"go.mod",
	"pyproject.toml",
	"deno.json",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"composer.json",
	"CMakeLists.txt",
	"AGENTS.md",
] as const;

/** Every marker, repository boundary first, so callers have one list to iterate. */
export const PROJECT_ROOT_MARKERS = [REPOSITORY_MARKER, ...MANIFEST_MARKERS] as const;

/**
 * How far below a repository root to look for nested repositories.
 *
 * Four, because that is where a container tree puts them. A directory organising work as
 * `<category>/<group>/<project>` holds its repositories at depth three or four and NOTHING
 * shallower, so a shorter scan reports a container as a clean project. Measured on the tree that
 * prompted this: zero nested repositories within two levels, twenty-nine within three, forty-one
 * within four.
 */
const CONTAINER_SCAN_DEPTH = 4;

/**
 * Nested repositories to collect before deciding.
 *
 * The decision needs only ONE nested repository the outer tree does not ignore, but the ignore
 * question is asked in a single batched call, so the scan collects a bounded sample rather than
 * asking once per repository. A tree with hundreds of them answers the same as a tree with this
 * many.
 */
const CONTAINER_SAMPLE_LIMIT = 64;

/**
 * Directories that never count as evidence of a container.
 *
 * A dependency vendored WITH its `.git` intact, or a checkout sitting in `node_modules`, says
 * nothing about whether the parent is a container: it is one project that happens to carry another
 * project's files. Without this list an ordinary project that vendors a dependency would be
 * classified as a container and could never be suggested, which is the opposite of the bug being
 * fixed here.
 */
const CONTAINER_SCAN_SKIP = new Set([
	"node_modules",
	"vendor",
	"third_party",
	"target",
	"build",
	"dist",
	"venv",
	"__pycache__",
]);

/**
 * Whether a repository root is really a CONTAINER of projects rather than a project.
 *
 * WHY A REPOSITORY BOUNDARY IS NOT ENOUGH. `.git` was treated as decisive, on the reasoning that a
 * repository boundary settles what counts as one project. It does not, because a tree can be under
 * version control for a reason that has nothing to do with being a project: a whole working tree
 * mirrored for disaster recovery is one repository holding dozens of unrelated projects, and
 * re-rooting a session there is worse than never re-rooting at all. Every path in the project the
 * session actually cares about stays long, and the rules that load are the container's, not the
 * project's.
 *
 * WHAT DOES NOT SEPARATE THEM: counting nested repositories. That was the first answer here and it
 * is wrong, because a perfectly ordinary project can carry many. The project that prompted this
 * carries a benchmark corpus of forty-odd checkouts under `packages/deepswe-bench/repo-cache/`, so
 * a count classifies it as a container, which is exactly backwards. Neither manifests nor child
 * count separate them either: the container and the project inside it both carry `AGENTS.md` and
 * `Cargo.toml` at their roots and have 59 and 47 direct children.
 *
 * WHAT DOES SEPARATE THEM: whether the outer repository IGNORES the nested one. That is not a
 * statistical signal, it is the maintainer's own statement. A project that vendors, caches, or
 * fixtures another repository gitignores it, saying "this is not part of me" -- both of the nested
 * repositories in the project above are ignored, by `repo-cache/` and `deep-swe/` entries. A tree
 * that merely HOLDS other projects ignores none of them, because they are not its content in the
 * first place: not one of the container's forty-one is ignored. So one unignored nested repository
 * is enough, and it costs a bounded directory scan plus a single batched `git check-ignore`, at
 * most {@link MAX_HINTS} times in a session.
 */
export async function isRepositoryContainer(directory: string): Promise<boolean> {
	const root = path.resolve(directory);
	const nested = await findNestedRepositories(root);
	if (nested.length === 0) return false;

	const ignored = await repo.ignored(root, nested);
	if (!ignored) {
		// The question could not be answered, so it must not be answered by guessing. Reporting "not
		// a container" would re-root the session into a tree that may well be one, which is the
		// defect this check exists to fix, and doing it silently is worse than doing it loudly.
		logger.warn(
			"Could not determine whether a repository holds other projects; not suggesting it as a re-root target",
			{
				directory: root,
				nested: nested.length,
			},
		);
		return true;
	}
	return nested.some(candidate => !ignored.has(candidate));
}

/**
 * Nested repository directories below `root`, as paths relative to it.
 *
 * Relative because that is what `git check-ignore` wants, and because an absolute path outside the
 * repository would be refused rather than answered.
 */
async function findNestedRepositories(root: string): Promise<string[]> {
	const found: string[] = [];
	let frontier = [root];

	for (let depth = 0; depth < CONTAINER_SCAN_DEPTH && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const current of frontier) {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fsPromises.readdir(current, { withFileTypes: true });
			} catch {
				// A directory this process cannot list contributes no evidence either way, and it
				// cannot hold a project this session could have reached.
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === REPOSITORY_MARKER) {
					// The root's own marker says nothing: every repository has one.
					if (current !== root) found.push(path.relative(root, current));
					continue;
				}
				// Hidden directories hold caches and tooling state, and the skip list holds the places
				// a dependency lands. Neither is where a co-tenant project lives, and both are where
				// an ordinary project's incidental checkouts do.
				if (entry.name.startsWith(".") || CONTAINER_SCAN_SKIP.has(entry.name)) continue;
				next.push(path.join(current, entry.name));
			}
			if (found.length >= CONTAINER_SAMPLE_LIMIT) return found;
		}
		frontier = next;
	}

	return found;
}

/**
 * Levels {@link resolveProjectRoot} will climb looking for a marker.
 *
 * Generous, because the walk stops at the first marker and at the cwd boundary long before this
 * matters; it is here so a directory with no marker anywhere above it cannot walk to `/`.
 */
const MAX_ROOT_WALK = 12;

/**
 * Directories that are launch points rather than projects, spelled without a home prefix.
 *
 * These are where a shell puts you, not where work lives. `/media`, `/mnt` and `/Volumes` hold
 * mount points; their DIRECT CHILDREN are the mounts themselves, which are equally not projects,
 * and that is handled in {@link isNonProjectDirectory} rather than by listing every possible
 * device name here.
 */
const LAUNCH_DIRECTORIES = ["/", "/home", "/Users", "/media", "/mnt", "/Volumes", "/tmp", "/var/tmp", "/opt", "/srv"];

/** Parents whose direct children are mount points or user homes rather than projects. */
const LAUNCH_PARENTS = ["/home", "/Users", "/media", "/mnt", "/Volumes"];

/**
 * Whether a directory is a place a session gets STARTED rather than a project.
 *
 * WHY THIS IS THE SIGNAL WORTH HAVING. Everything else in this file waits for evidence to
 * accumulate: three files under one foreign directory before anything is said. That is the right
 * shape for detecting that work has DRIFTED, and the wrong shape for the far more common failure,
 * which is that the session was never rooted anywhere sensible to begin with. A session launched
 * from `$HOME`, from a mount point, or from `/` is misrooted from its first message, and waiting
 * for three files of evidence means the first several tool calls are all paid at full absolute-path
 * price and the project's own `AGENTS.md` never loads at all. The `<working-directory>` prompt block
 * has listed "the working directory is a home, temp, or launch directory" as a re-root case since it
 * was written, and nothing anywhere ever checked it.
 *
 * Purely lexical and synchronous: no filesystem access, so it is safe to ask anywhere, including on
 * every tool call. The question "does this directory look like a project" needs the filesystem and
 * is {@link isNonProjectRoot}.
 *
 * Windows drive roots (`C:\`) and the Windows user directories are recognised on their own terms
 * rather than by translating them to POSIX shapes, because a session on Windows launched from
 * `C:\Users\someone` has exactly the problem this is looking for.
 */
export function isNonProjectDirectory(directory: string, options: { home?: string; tmp?: string } = {}): boolean {
	// The Windows spellings are matched on the RAW text, before any resolution. `path.resolve` on a
	// POSIX host reads `C:/` as a relative segment and answers `<cwd>/C:`, so resolving first would
	// make every Windows shape unrecognisable exactly where it needs recognising.
	const raw = directory.split("\\").join("/");
	// The shared stripper rather than a local regex: one owner for how many trailing slashes come
	// off, so `C:\\` and `C:/` cannot start answering differently here than they do anywhere else.
	// The `|| "/"` keeps a bare root a root instead of the empty string.
	const lower = trimTrailingSlashes(raw.toLowerCase()) || "/";
	if (/^[a-z]:$/.test(lower)) return true;
	if (/^[a-z]:\/users$/.test(lower)) return true;
	if (/^[a-z]:\/users\/[^/]+$/.test(lower)) return true;

	const resolved = path.resolve(directory);
	const home = options.home ?? os.homedir();
	const tmp = options.tmp ?? os.tmpdir();

	// The user's own home, and the temp directory, are launch points by definition.
	if (resolved === path.resolve(home)) return true;
	if (resolved === path.resolve(tmp)) return true;
	// A direct child of the temp directory is a scratch workspace, not a project.
	if (path.dirname(resolved) === path.resolve(tmp)) return true;

	// Any filesystem root: POSIX `/`, and a Windows drive root, which `path.dirname` reports as
	// itself exactly as it does for `/`.
	if (path.dirname(resolved) === resolved) return true;

	const posix = resolved.split(path.sep).join("/");
	if (LAUNCH_DIRECTORIES.includes(posix)) return true;
	// A mount point or a user's home under one of the parents above.
	const parent = posix.slice(0, posix.lastIndexOf("/")) || "/";
	return LAUNCH_PARENTS.includes(parent);
}

/**
 * Whether the session's working directory is a bad place to be rooted, and why.
 *
 * Three independent reasons, cheapest first, each of which alone means the same thing: the paths
 * this session works with will stay long and the project's rules will not load.
 *
 * 1. It is a launch directory. Lexical, free, and catches the common case outright.
 * 2. It carries no project marker at all. A directory with no `.git`, no manifest and no
 *    `AGENTS.md` is not the root of anything, whatever its path looks like. This is what catches a
 *    disk root like `/media/<user>/<volume>` that no name list would have predicted.
 * 3. It is a repository that holds other projects. The case that needs the most work to detect,
 *    and the one a marker check actively gets wrong: a container tree can carry a root manifest
 *    and an `AGENTS.md` exactly as a project does.
 *
 * Returns null when the directory is a fine place to be, so a caller can treat the reason as the
 * thing worth saying rather than re-deriving it.
 */
export async function isNonProjectRoot(directory: string): Promise<NonProjectReason | null> {
	if (isNonProjectDirectory(directory)) return "launch-directory";

	let marked = false;
	for (const marker of PROJECT_ROOT_MARKERS) {
		if (await hasEntry(directory, marker)) {
			marked = true;
			break;
		}
	}
	if (!marked) return "no-project-marker";

	if ((await hasEntry(directory, REPOSITORY_MARKER)) && (await isRepositoryContainer(directory))) {
		return "holds-other-projects";
	}
	return null;
}

/** Why a working directory is not a project root. */
export type NonProjectReason = "launch-directory" | "no-project-marker" | "holds-other-projects";

/**
 * How each reason is said to the model, owned here beside the reason it explains.
 *
 * In the prompt rather than in the enum name because the model reads the sentence, and one place
 * rather than a branch in the template because the template language has no equality helper and
 * adding one to spell three phrases would put the wording somewhere the type cannot reach.
 */
export const NON_PROJECT_REASON_TEXT: Record<NonProjectReason, string> = {
	"launch-directory": "it is a home, temp, mount, or root directory that a shell starts in",
	"no-project-marker": "it holds no `.git`, no build manifest, and no `AGENTS.md`",
	"holds-other-projects": "it is a repository holding other projects rather than being one itself",
};

/**
 * The project root a qualifying directory belongs to.
 *
 * WHY THIS EXISTS. {@link RerootDetector} ranks candidates deepest-first, and that is right for
 * choosing WHICH activity to report: every ancestor of a busy directory is credited the same
 * evidence, so an evidence-first rule would name the common ancestor of two unrelated projects.
 * It is wrong for choosing WHERE TO POINT. Three reads under
 * `keyhog/crates/cli/src/subcommands/` made that directory the winner, and the hint then advised
 * re-rooting five levels inside a project the user thinks of as one thing. Re-rooting there is
 * actively worse than not re-rooting: every other file in the same project becomes an absolute
 * path again, and the project's own root `AGENTS.md` is no longer the nearest rule file. The rule
 * markdown had said "re-root to that project's ROOT, not the directory the file happens to sit in"
 * since it was written; the detector simply never did it.
 *
 * So the deepest directory decides WHAT to report and this decides WHERE. The walk stops at the
 * first `.git`, because a repository boundary settles the question, and otherwise returns the
 * OUTERMOST manifest-bearing directory found: in a workspace, the member manifests are the deep
 * answer and the workspace manifest is the one the user means.
 *
 * A directory containing `cwd` is never returned. Re-rooting to an ancestor of the working
 * directory widens the session's reach rather than moving it, and turns every path that is
 * currently relative into an absolute one.
 *
 * Returns `directory` unchanged when nothing above it is marked, which is a real answer and not a
 * fallback: an unmarked tree has no root to prefer, and the observed directory is still where the
 * work is.
 */
export async function resolveProjectRoot(directory: string, cwd: string): Promise<string> {
	let current = path.resolve(directory);
	let outermostManifest: string | undefined;

	for (let step = 0; step < MAX_ROOT_WALK; step++) {
		// The same boundary `#credit` enforces: an ancestor of cwd is not a re-root target.
		if (isPathWithinCwd(cwd, current)) break;

		if (await hasEntry(current, REPOSITORY_MARKER)) {
			// A repository that holds other repositories is a container, and a container is not a
			// project. Answering it would re-root the session to a tree that merely happens to be
			// under version control, leaving every path in the project the session cares about as
			// long as it was and loading the container's rules instead of the project's.
			if (!(await isRepositoryContainer(current))) return current;
			// Nothing ABOVE a container is a project either, so the climb ends here rather than
			// continuing to an even larger tree. The best remaining answer is the outermost manifest
			// seen on the way up, which is a directory inside the container.
			break;
		}

		for (const marker of MANIFEST_MARKERS) {
			if (!(await hasEntry(current, marker))) continue;
			// Remembered and overwritten by any found higher up, so the last one standing is the
			// outermost.
			outermostManifest = current;
			break;
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return outermostManifest ?? path.resolve(directory);
}

/** Whether `directory` holds `name`, treating an unreadable entry as absent. */
async function hasEntry(directory: string, name: string): Promise<boolean> {
	try {
		await fsPromises.stat(path.join(directory, name));
		return true;
	} catch {
		// Absence is the ordinary answer: most directories on the way up carry no marker. A marker
		// that cannot be stat'ed is one this session could not have used either.
		return false;
	}
}

/** Path segments in `directory`, used to pick the more specific of two candidates. */
function depthOf(directory: string): number {
	return directory.split(path.sep).filter(Boolean).length;
}

/**
 * True when `candidate` is the better thing to suggest than `incumbent`.
 *
 * DEEPEST FIRST, because the deepest qualifying directory is the specific answer.
 * Every ancestor of a qualifying directory also qualifies (it was credited the same
 * evidence keys), and a common ancestor of two unrelated projects accumulates the sum
 * of both, so it would win any comparison that ranked by evidence first -- and
 * `/srv` is never the useful answer when the work is under `/srv/a`.
 *
 * Depth is counted in path SEGMENTS. It used to be compared as string LENGTH, which
 * within one ancestor chain is accidentally equivalent (a child's path is always
 * longer than its parent's) and between two unrelated trees is arbitrary: it made the
 * winner a function of how long the directory names happened to be, so
 * `/srv/averyverylongprojectname` outranked `/srv/a/b/c/d` while being four levels
 * shallower.
 *
 * At equal depth the trees are unrelated and evidence decides, which is the honest
 * answer to "the session worked in two places at once": name the one it spent more of
 * itself in. The final lexicographic tie-break makes a full tie deterministic instead
 * of a function of `Map` insertion order, which is a function of the order files
 * happened to be read.
 */
function outranks(
	candidate: { directory: string; fileCount: number },
	incumbent: { directory: string; fileCount: number },
): boolean {
	const candidateDepth = depthOf(candidate.directory);
	const incumbentDepth = depthOf(incumbent.directory);
	if (candidateDepth !== incumbentDepth) return candidateDepth > incumbentDepth;
	if (candidate.fileCount !== incumbent.fileCount) return candidate.fileCount > incumbent.fileCount;
	return candidate.directory < incumbent.directory;
}

export interface RerootHint {
	/** The directory worth re-rooting into. */
	directory: string;
	/** Distinct files touched under it. */
	fileCount: number;
	/** The sentence to append to the tool result. */
	text: string;
}

/**
 * Tracks out-of-cwd filesystem activity for one session and reports when a
 * directory has become the session's real subject.
 *
 * Session-scoped by construction: one instance per `createTools` call, so counts
 * never leak between sessions and a subagent starts clean.
 */
export class RerootDetector {
	/** Candidate directory to the distinct evidence keys seen under it. */
	readonly #filesByDirectory = new Map<string, Set<string>>();
	/** Directories already mentioned, so each is suggested at most once. */
	readonly #announced = new Set<string>();
	/**
	 * Project roots already advised about, so a second busy directory in the SAME project cannot
	 * earn a second identical hint.
	 *
	 * The ancestor suppression below cannot do this on its own: it silences the ancestors of the
	 * winner, and two sibling subtrees of one project are ancestors of neither. Reading three files
	 * under `keyhog/crates/a/src` and then three under `keyhog/crates/b/src` produced two
	 * candidates, and once both resolve to `keyhog` they are the same advice printed twice.
	 */
	readonly #announcedRoots = new Set<string>();
	#hintsEmitted = 0;
	/** Calls that named an out-of-cwd working directory, used to key each one. */
	#workingDirectoryCalls = 0;

	/**
	 * Record the paths a tool call touched and return a hint if one is now due.
	 *
	 * `targets` are raw path strings as the tool declared them, resolved here
	 * against `cwd` exactly as the boundary resolves them. Resolution is lexical
	 * on purpose: this is a suggestion, not a permission decision, so it must not
	 * pay for a `realpath` on every call to reach a conclusion a symlink could
	 * only make marginally more accurate.
	 */
	observe(targets: readonly string[], cwd: string, workingDirectory?: string): RerootHint | undefined {
		if (!cwd || this.#hintsEmitted >= MAX_HINTS) return undefined;

		// A tool told to RUN somewhere is the strongest evidence there is, and it is
		// the only evidence `bash` produces. Bash declares no filesystem targets,
		// because its paths live inside a shell command that nothing here should be
		// parsing, so a session that builds, greps and edits another project through
		// bash was invisible to the file counter below. Its `cwd` argument is not:
		// it is an explicit statement of where the work is, and it needs no parsing.
		//
		// Each such call counts once, keyed by a counter rather than by the
		// directory, because unlike a file the same directory named three times IS
		// three pieces of evidence. Running one command there could be a check;
		// running three is the session's subject.
		if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
			const resolved = resolveToCwd(workingDirectory, cwd);
			// Inside cwd is evidence too when cwd is not a project, on the same reasoning as the
			// file loop below: a command RUN in a subdirectory names where the work is, and for a
			// misrooted session that subdirectory is the answer rather than something to ignore.
			const usable = isPathWithinCwd(resolved, cwd)
				? isNonProjectDirectory(cwd) && resolved !== path.resolve(cwd)
				: true;
			if (usable) {
				this.#workingDirectoryCalls++;
				this.#credit(`run#${this.#workingDirectoryCalls}`, resolved, cwd);
			}
		}

		// A session rooted somewhere that is not a project changes what counts as evidence.
		//
		// THE BLIND SPOT THIS CLOSES. Everything below credits only paths OUTSIDE cwd, which is
		// right when cwd is a project: work inside it is the work, and there is nothing to suggest.
		// It makes the detector structurally unable to see the most common misrooting there is.
		// Launch the agent from `$HOME` and work in `$HOME/code/project`, and every path touched is
		// INSIDE cwd, so nothing is ever credited and no hint can ever fire, however long the
		// session runs. Lowering the threshold does not help: the evidence was never collected.
		//
		// So when cwd is not a project, a directory BENEATH it is exactly what wants naming.
		const misrooted = isNonProjectDirectory(cwd);
		const root = path.resolve(cwd);

		for (const raw of targets) {
			if (typeof raw !== "string" || raw.trim().length === 0) continue;
			// Peel the read selector (`:1-40`, `:raw`) before anything else. The cwd
			// boundary can leave it attached because a suffix cannot introduce `../`
			// traversal, so it never changes whether a path is inside cwd. Here it
			// changes the ANSWER: this counts DISTINCT FILES, and `a.ts:1-40` and
			// `a.ts:41-80` are one file read twice. Left attached, three paged reads of
			// a single file fired the hint, which is precisely the incidental
			// cross-project access the threshold exists to stay silent about.
			// `splitPathAndSel` is the strict filesystem-path splitter, so a file
			// genuinely named `a:1-50` is left alone.
			const resolved = resolveToCwd(splitPathAndSel(raw).path, cwd);
			const directory = path.dirname(resolved);
			if (isPathWithinCwd(resolved, cwd)) {
				if (!misrooted) continue;
				// A file sitting directly in cwd names no subdirectory to move to, and crediting cwd
				// itself would suggest re-rooting to where the session already is.
				if (directory === root) continue;
			}
			this.#credit(resolved, directory, cwd);
		}

		return this.#dueHint(cwd);
	}

	/**
	 * Count one piece of evidence against `startDirectory` and each ancestor
	 * within the cap.
	 *
	 * `key` is what makes the count a count of DISTINCT evidence: a file path for a
	 * file, so three paged reads of one file count once, and a per-call token for a
	 * working directory, so three commands run in one place count three times.
	 */
	#credit(key: string, startDirectory: string, cwd: string): void {
		let directory = startDirectory;
		for (let step = 0; step < MAX_ANCESTOR_DEPTH; step++) {
			// An ancestor that contains cwd is not a re-root target: suggesting it
			// would WIDEN the session's reach rather than move it, and every path
			// currently relative would become absolute.
			if (isPathWithinCwd(cwd, directory)) break;
			let files = this.#filesByDirectory.get(directory);
			if (!files) {
				files = new Set();
				this.#filesByDirectory.set(directory, files);
			}
			files.add(key);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}

	/**
	 * The deepest not-yet-announced directory at or over threshold.
	 *
	 * Deepest wins because it is the most specific answer. Every ancestor of a
	 * qualifying directory also qualifies (it was credited the same files), and
	 * suggesting `/home/user` when the work is in `/home/user/code/thing` would be
	 * technically true and useless.
	 */
	#dueHint(cwd: string): RerootHint | undefined {
		// A session rooted somewhere that is not a project needs no evidence that the work is
		// elsewhere: there is nothing here for a read to be incidental to. Asked lexically so this
		// stays a synchronous, filesystem-free path that runs on every call.
		const threshold = isNonProjectDirectory(cwd) ? MISROOTED_FILE_THRESHOLD : REROOT_FILE_THRESHOLD;

		let best: { directory: string; fileCount: number } | undefined;
		for (const [directory, files] of this.#filesByDirectory) {
			if (files.size < threshold || this.#announced.has(directory)) continue;
			// Anything inside a project already advised about would repeat that advice.
			if (this.#isInsideAnnouncedRoot(directory)) continue;
			if (!best || outranks({ directory, fileCount: files.size }, best)) {
				best = { directory, fileCount: files.size };
			}
		}
		if (!best) return undefined;

		// Every ancestor of the chosen directory is suppressed too. They describe the
		// same activity, so announcing them later would be the same hint again with a
		// vaguer answer.
		for (const directory of this.#filesByDirectory.keys()) {
			if (best.directory === directory || isPathWithinCwd(best.directory, directory)) {
				this.#announced.add(directory);
			}
		}
		this.#hintsEmitted++;
		return { ...best, text: formatRerootHint(best.directory, best.fileCount, cwd) };
	}

	/** True when `directory` sits inside a project root this session has already advised about. */
	#isInsideAnnouncedRoot(directory: string): boolean {
		for (const root of this.#announcedRoots) {
			if (isPathWithinCwd(directory, root)) return true;
		}
		return false;
	}

	/**
	 * Record the project root a hint actually pointed at.
	 *
	 * Called by the wrapper after {@link resolveProjectRoot}, because that resolution touches the
	 * filesystem and this class is deliberately synchronous and lexical everywhere else: it runs on
	 * every tool call, and a hint is not worth a `stat` per call. The resolution happens at most
	 * {@link MAX_HINTS} times in a session, on the calls that already earned a hint.
	 */
	recordAnnouncedRoot(root: string): void {
		this.#announcedRoots.add(path.resolve(root));
	}
}

/**
 * The hint sentence.
 *
 * It states the observation, the concrete call, and what the call buys, then
 * gives explicit permission to ignore it. The last part is load-bearing: a
 * directive the model cannot decline turns every incidental cross-project read
 * into a re-root, and re-rooting away from the user's project is worse than the
 * absolute paths it saves.
 */
export function formatRerootHint(
	directory: string,
	fileCount: number,
	cwd: string,
	options: { callable?: boolean } = {},
): string {
	// Singular when it is one, because the misrooted path below fires at a count of one and "1 files
	// or commands" is the first thing a reader sees.
	const evidence = fileCount === 1 ? "1 file or command so far" : `${fileCount} files or commands now`;
	// TWO OBSERVATIONS, because the same sentence is not true in both cases. The hint normally fires
	// for a directory OUTSIDE cwd, and said so. A session rooted somewhere that is not a project
	// fires for a directory INSIDE cwd, where "which is outside the session working directory" is
	// simply false, and a hint whose first clause is visibly wrong is one the model learns to skip.
	const inside = isPathWithinCwd(directory, cwd);
	const observation = inside
		? `The session working directory (${cwd}) is not a project root, and the work is under ${directory} (${evidence}). `
		: `You keep working under ${directory} (${evidence}), which is outside the session working directory (${cwd}). `;
	const payoff = `paths in tool headers become relative instead of absolute, and that project's AGENTS.md rules load. `;
	// "Passing through" is the wrong escape hatch for a misrooted session: there is nothing here to
	// pass through FROM, so the only reason to decline is that the work is not really there.
	const optOut = inside
		? "If the work is not really there, ignore this."
		: "If you are only passing through, ignore this.";
	// The two spellings differ in exactly one thing: whether the tool is in the
	// toolset right now. Telling a model to call a tool it does not have produces a
	// failed call and, worse, teaches it that this advice is wrong.
	return options.callable === false
		? `${observation}If the rest of this task is there, re-root to it: ${payoff}` +
				`The ${SET_CWD_TOOL_NAME} tool is NOT in your active toolset and this session could not activate it, so find and activate it first (search_tool_bm25) instead of calling it blind. ` +
				optOut
		: `${observation}If the rest of this task is there, call ${SET_CWD_TOOL_NAME} with ${directory}: ${payoff}${optOut}`;
}

/**
 * The session state the wrapper needs: the live cwd, and enough of the discovery
 * surface to make the tool it recommends actually callable.
 *
 * Both discovery members are optional because a plain tool session (tests, the
 * SDK's pre-session window) has neither, and a hint is not worth a hard dependency
 * on machinery that may not be wired.
 */
export interface RerootHintSession {
	readonly cwd: string;
	/** True when `name` is in the toolset the model can currently call. */
	isToolActive?(name: string): boolean;
	/** Add discoverable tools to the active toolset; returns the ones newly activated. */
	activateDiscoveredTools?(toolNames: string[]): Promise<string[]>;
}

/**
 * Put `set_cwd` in the model's toolset, and report whether it is now callable.
 *
 * WHY THIS EXISTS, AND WHY THE HINT WAS USELESS WITHOUT IT. `set_cwd` is a
 * `discoverable` tool, so under `tools.discoveryMode: all` it is deliberately
 * absent from the initial toolset: most sessions never re-root, and the slot is not
 * free. The hint then told the model to call `set_cwd`, the model tried, and there
 * was no such tool in the request. That is not a hint that lands badly, it is a hint
 * that CANNOT be followed, and it is why re-rooting appeared to work in some
 * sessions and not others: it worked exactly where something else had already
 * activated the tool.
 *
 * The evidence that fires the hint is also the evidence that this session needs the
 * tool, so the harness activates it rather than asking the model to go find it. That
 * spends one tool slot in the sessions that have demonstrably wandered out of cwd,
 * and nothing in the sessions that have not.
 *
 * Returns false when the session cannot make it callable. The caller must then say
 * so in the hint: naming a tool that is not there is the bug this function exists to
 * end, and printing the same confident sentence anyway would only hide it again.
 */
export async function ensureSetCwdCallable(session: RerootHintSession): Promise<boolean> {
	// No activation tracking at all means the toolset is fixed: `set_cwd` is either
	// in it or was never going to be, and there is nothing to do or to report.
	if (!session.isToolActive) return true;
	if (session.isToolActive(SET_CWD_TOOL_NAME)) return true;
	if (!session.activateDiscoveredTools) return false;
	const activated = await session.activateDiscoveredTools([SET_CWD_TOOL_NAME]);
	// `activateDiscoveredTools` reports only what it NEWLY added, so a tool that
	// became active by another route in the meantime reads as "not activated". Ask
	// the session again rather than trusting the delta.
	return activated.includes(SET_CWD_TOOL_NAME) || session.isToolActive(SET_CWD_TOOL_NAME);
}

/**
 * The directory a tool call was told to run in, when it names one.
 *
 * Read from the arguments by SHAPE rather than from a list of tool names. Any
 * tool taking a `cwd` argument means the same thing by it in this codebase, so a
 * name list would be a second place to update every time one is added, and it
 * would be wrong the first time somebody forgot. `bash` is the case that
 * matters today: it declares no filesystem targets, so without this the entire
 * build/test/grep half of a session is invisible to the detector.
 */
export function workingDirectoryArg(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const cwd = (args as { cwd?: unknown }).cwd;
	return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

const kRerootWrapped = Symbol.for("veyyon.rerootHintWrapped");

/**
 * Wrap a tool so its result carries a re-root hint when one becomes due.
 *
 * Two signals feed it. Tools that declare `filesystemTargets` contribute the
 * paths they read or write, which is the same set the cwd boundary governs; and
 * any tool called with a `cwd` argument contributes that directory, which is how
 * `bash` is seen at all. Unlike the boundary, this runs in EVERY approval mode:
 * `cwdEscapingTargets` is skipped under yolo, and yolo is where a session is most
 * likely to wander out of cwd without ever being asked about it.
 *
 * Every tool is wrapped rather than only the filesystem ones, because the second
 * signal can come from any of them. The added work for a tool that contributes
 * neither is one property read on a call that has already done real IO.
 *
 * The hint is appended to the result rather than replacing anything, and only on
 * a successful call. A failed call is the model's problem to solve first;
 * stacking advice onto an error is how a result becomes unreadable.
 */
export function wrapToolWithRerootHint<T extends AgentTool<any, any, any>>(
	tool: T,
	detector: RerootDetector,
	session: RerootHintSession,
): T {
	if (kRerootWrapped in tool) return tool;

	const originalExecute = tool.execute.bind(tool);
	const wrapped = async (...args: Parameters<typeof originalExecute>): Promise<AgentToolResult<unknown>> => {
		const result = await originalExecute(...args);
		// `filesystemTargets` is pure argument parsing, but it is third-party-ish
		// surface (extensions implement it too) and a throw here would fail a tool
		// call that already succeeded. A hint is never worth that.
		let hint: RerootHint | undefined;
		try {
			const targets = hasFilesystemTargets(tool) ? tool.filesystemTargets(args[1]) : [];
			hint = detector.observe(targets, session.cwd, workingDirectoryArg(args[1]));
		} catch {
			return result;
		}
		if (!hint || result.isError) return result;
		// Point at the PROJECT, not at the busiest directory inside it. The detector ranks
		// deepest-first to decide which activity to report, which would otherwise advise re-rooting
		// several levels inside a project the user thinks of as one thing. Resolved here rather
		// than in `observe` because it touches the filesystem and `observe` runs on every call.
		let target = hint.directory;
		try {
			target = await resolveProjectRoot(hint.directory, session.cwd);
		} catch {
			// The walk is `stat` calls on ancestors that may have become unreadable mid-session.
			// The observed directory is still a true statement about where the work is, so the hint
			// is still worth printing; it just cannot be improved into the project root.
			target = hint.directory;
		}
		detector.recordAnnouncedRoot(target);

		// Activation happens HERE, once, on the call that earned the hint, rather than
		// on every observation: a session that read one file next door must not acquire
		// a tool it was never advised to use.
		let text = formatRerootHint(target, hint.fileCount, session.cwd);
		try {
			if (!(await ensureSetCwdCallable(session))) {
				text = formatRerootHint(target, hint.fileCount, session.cwd, { callable: false });
			}
		} catch (error) {
			// Activation reaches into the live session and can fail for reasons that have
			// nothing to do with this call. Name the missing tool and the reason;
			// swallowing it and still saying "call set_cwd" is the original bug.
			text = `${formatRerootHint(target, hint.fileCount, session.cwd, { callable: false })} (Activating ${SET_CWD_TOOL_NAME} failed: ${errorMessage(error)}.)`;
		}
		return { ...result, content: [...result.content, { type: "text" as const, text }] };
	};

	return Object.defineProperties(tool, {
		[kRerootWrapped]: { value: true, enumerable: false, configurable: true },
		execute: { value: wrapped, enumerable: false, configurable: true, writable: true },
	});
}
