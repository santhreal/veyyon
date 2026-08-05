#!/usr/bin/env bun
// Source-path gate for documentation: every repo-relative source path a doc
// names inside an inline code span must exist in the working tree.
//
// Why this gate exists, and why the link checker cannot do it. Docs name source
// files two ways. `[the registry](../src/foo.ts)` is a markdown link, and
// check-doc-links resolves it. But the far more common form in this repo is a
// bare code span: "`packages/coding-agent/src/system-prompt-builder/prompt-blocks.ts`
// (the section registry: which sections exist, their banners, and their order)".
// check-doc-links STRIPS inline code spans on purpose, so sample links inside
// them are not scanned as real ones -- which means every path written that way
// is invisible to every gate in the repo.
//
// That invisibility is not theoretical. `prompt-blocks.ts` was split into
// `section-registry.ts` and `prompt-sections.ts`, and `docs/system-prompt-
// customization.md` went on naming the old file in three places, including the
// "Primary implementation" list a contributor reads FIRST and the two lines in
// section 10 that tell them which file to edit to add a section. Nothing failed:
// the doc-links gate saw a code span, the doc-imports gate saw no import, and
// the doc-freshness gate only knows whether a stamp is stale. The instruction
// "two things are worth knowing before you edit prompt-blocks.ts" survived the
// file it was about.
//
// A path counts if it starts with one of the repo's top-level source directories
// and ends in a source-ish extension, so ordinary prose and shell fragments are
// not mistaken for paths. Directory paths (trailing slash) are checked too. A
// path inside a FENCED block is skipped: fences hold examples, hypothetical
// trees, and other repos' layouts, and a gate that fails on those gets switched
// off. Nothing is dropped silently: skipped-in-fence paths are counted.
//
// CI gate: .github/workflows/docs.yml.

import * as fs from "node:fs";
import * as path from "node:path";
import { listTrackedMarkdown, readIfPresent } from "./check-doc-links";

export interface DeadPath {
	file: string;
	line: number;
	target: string;
	reason: string;
}

export interface PathCheckResult {
	filesChecked: number;
	pathsChecked: number;
	/** Code-span paths inside fenced blocks, counted rather than silently dropped. */
	skippedInFence: number;
	dead: DeadPath[];
}

/**
 * Top-level directories a repo-relative source path may start with.
 *
 * An allowlist rather than "anything with a slash", because docs are full of
 * slash-bearing text that is not a path in THIS repo: `provider/model` selectors,
 * `~/.veyyon/config.yml`, `and/or`, other projects' trees. Anchoring on real
 * top-level directories is what keeps the gate's failures worth reading.
 *
 * `.veyyon/` is deliberately absent, even though it is a real tracked directory.
 * It names two different things in this repo's docs and only one of them is a
 * file here: `.veyyon/skills/ui` is tracked, while `.veyyon/mcp.json`,
 * `.veyyon/settings.json` and `.veyyon/RULES.md` are files a USER creates in
 * THEIR project. Every page that teaches project configuration writes the second
 * kind, so anchoring on the prefix produces a screenful of failures that are all
 * the documentation working correctly, and a gate whose failures are usually
 * wrong is a gate people turn off.
 */
const SOURCE_ROOTS = ["packages/", "scripts/", "docs/", "website/", "examples/", "assets/", ".github/"] as const;

/**
 * Extensions that make a code span a FILE reference rather than a prose fragment.
 *
 * `packages/coding-agent/src/tools` (a directory, no extension) is handled by the
 * trailing-slash rule instead: an extensionless span is far more likely to be a
 * package name, a partial path, or a glob than a file this gate can resolve.
 */
const SOURCE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".json",
	".md",
	".yml",
	".yaml",
	".toml",
	".sh",
	".ps1",
	".css",
	".html",
	".rs",
	".py",
	".txt",
	".dict",
] as const;

/** Whether a code-span body looks like a repo-relative path this gate can resolve. */
export function looksLikeSourcePath(span: string): boolean {
	if (!SOURCE_ROOTS.some(root => span.startsWith(root))) return false;
	// A span holding whitespace or a pipe is a COMMAND, not a path: the design-language
	// doc writes `scripts/demos/render-transcript-rail.ts | scripts/demos/render-proof.ts`,
	// where both files exist and the span as a whole resolves to nothing.
	if (/[\s|<>&;]/.test(span)) return false;
	// A glob or a placeholder names a SET of files, not one, so there is nothing to
	// resolve and a failure would be noise. `**` and `<name>` are the two forms the
	// docs actually use.
	if (/[*?]/.test(span) || span.includes("<") || span.includes("{")) return false;
	// A line/column suffix (`file.ts:120`) still names a real file.
	const withoutLocator = span.replace(/:\d+(:\d+)?$/, "");
	if (withoutLocator.endsWith("/")) return true;
	return SOURCE_EXTENSIONS.some(ext => withoutLocator.endsWith(ext));
}

/** Strip a trailing `:line[:col]` locator so the path resolves on disk. */
function withoutLocator(span: string): string {
	return span.replace(/:\d+(:\d+)?$/, "");
}

interface FoundPath {
	line: number;
	target: string;
	inFence: boolean;
}

/**
 * Every inline code span in a document, with the line it sits on and whether it
 * is inside a fenced block.
 *
 * Fence state is tracked rather than the whole fence being deleted, because the
 * count of skipped-in-fence paths is reported: a gate that silently discards a
 * category cannot be told apart from one that found nothing there.
 */
export function extractCodeSpanPaths(markdown: string): FoundPath[] {
	const out: FoundPath[] = [];
	let inFence = false;
	let fenceMarker = "";
	const lines = markdown.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = line.match(/^\s*(```+|~~~+)/);
		if (fence) {
			const marker = fence[1]![0]!.repeat(3);
			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				inFence = false;
			}
			continue;
		}
		for (const match of line.matchAll(/`([^`\n]+)`/g)) {
			const span = match[1]!.trim();
			if (!looksLikeSourcePath(span)) continue;
			out.push({ line: i + 1, target: span, inFence });
		}
	}
	return out;
}

/**
 * The package directory a doc lives in, or undefined for a doc outside `packages/`.
 *
 * A README inside a package writes its own paths package-relative, because that is
 * how its reader will run them: `packages/catalog/README.md` says "regenerate with
 * `scripts/generate-models.ts`", and `packages/catalog/scripts/generate-models.ts`
 * is exactly where that file is. Judging those against the repo root alone reports
 * every in-package README as broken, which is the false-positive class that would
 * have made this gate unusable.
 */
function enclosingPackage(relFile: string): string | undefined {
	const parts = relFile.split("/");
	if (parts[0] !== "packages" || parts.length < 3) return undefined;
	return `${parts[0]}/${parts[1]}`;
}

/**
 * Paths the repository itself declares are generated, asked of `.gitignore`.
 *
 * A doc that names a build output names something no clean checkout contains:
 * `packages/deepswe-bench/runs/` appears on the first benchmark run,
 * `packages/natives/native/.build/` when napi-rs compiles, and
 * `tool-views.generated.js` when `bun run gen:tool-views` does. The gate reported
 * all of them as rot, and they are the opposite: a doc telling you where the
 * build will put something is doing its job.
 *
 * `.gitignore` is asked rather than a second list being kept here, because the
 * repository already answers "is this generated?" in exactly one place, and a
 * list maintained beside it would drift the first time a build output moved. A
 * single `git check-ignore` call, batched over every candidate, so the gate stays
 * one process.
 *
 * This is NOT the ratchet baseline. The baseline is a promise to remove a dead
 * path; this is a statement that the path is alive and produced by a build.
 *
 * A directory that is not a git repository declares nothing generated, so the
 * answer there is an empty set. That is the accurate answer to the question and
 * not a fallback: the tests below build a doc tree in a temp directory with no
 * `.git`, and every path in it is exactly as tracked as it looks.
 */
function ignoredPaths(rootDir: string, candidates: readonly string[]): Set<string> {
	if (candidates.length === 0) return new Set();
	const probe = Bun.spawnSync(["git", "-C", rootDir, "rev-parse", "--is-inside-work-tree"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (probe.exitCode !== 0) return new Set();
	const run = Bun.spawnSync(["git", "check-ignore", "--stdin"], {
		cwd: rootDir,
		stdin: new TextEncoder().encode(`${candidates.join("\n")}\n`),
	});
	// git exits 1 when nothing matched, which is an answer and not a failure. Any
	// other code means git could not be asked, and a gate that cannot ask must
	// report what it saw rather than quietly passing everything.
	if (run.exitCode !== 0 && run.exitCode !== 1) {
		throw new Error(`git check-ignore failed (exit ${run.exitCode}): ${new TextDecoder().decode(run.stderr)}`);
	}
	return new Set(
		new TextDecoder()
			.decode(run.stdout)
			.split("\n")
			.filter(line => line !== ""),
	);
}

/**
 * Whether `target`, as written in `relFile`, names something that exists.
 *
 * Two bases, in the order a reader would try them: the repo root, then the package
 * the doc belongs to. A doc outside `packages/` gets the repo root only, so a path
 * in `docs/internal/` must be written from the root -- which is the whole point,
 * since its reader has no package to be relative to.
 */
function resolvesFor(rootDir: string, relFile: string, target: string): boolean {
	if (fs.existsSync(path.join(rootDir, target))) return true;
	const pkg = enclosingPackage(relFile);
	return pkg !== undefined && fs.existsSync(path.join(rootDir, pkg, target));
}

/**
 * Paths this gate knows are dead and does not fail on, as `file:line:target`.
 *
 * A RATCHET, not an exemption list, and the distinction is what makes the gate
 * survive: a flat ban laid over pre-existing debt is switched off by the first
 * person it blocks. Everything here is a path the gate cannot tell from real rot
 * but a reader can, and each is one of three kinds:
 *
 *  - a path in SOMEONE ELSE'S repository (`assets/search_tool_trajectory.html`
 *    is DeepSeek's, and the surrounding sentence says so);
 *  - a file the reader is being told to CREATE (`scripts/probe.ts` in a skill,
 *    `scripts/foo.js` in a prompt teaching skill invocation), which by definition
 *    does not exist yet;
 *  - a path in the USER'S project rather than this one
 *    (`.github/copilot-instructions.md`, the illustrative
 *    `packages/server/src/database/connection.ts` that argot's docs use as a
 *    stand-in for "some long path in your repo").
 *
 * An entry here is a promise to remove it, and two have been kept. The list used
 * to carry `docs/internal/natives-architecture.md:77`, which named a generator
 * script for the per-platform natives leaf packages. The script did not move, it
 * was deleted when the npm publish channel was removed, and the doc had gone on
 * describing it. The doc now describes what actually ships, so the path is gone
 * and the entry with it. It also carried `docs/context-files.md:151:docs/setup.md`,
 * which was only the filler path in an example of trailing-punctuation trimming;
 * the example now uses `notes/setup.md`, which names no source root, so it needs
 * no entry at all. Every remaining entry is one of the three kinds above.
 *
 * Adding to this list is deliberately awkward: the exact line number is part of
 * the key, so an entry stops matching the moment the doc is edited around it, and
 * a stale entry is caught by `check-doc-paths.test.ts`.
 */
export const DEAD_PATH_BASELINE: readonly string[] = Object.freeze([
	".veyyon/skills/tool-prompt-optimization/SKILL.md:14:scripts/probe.ts",
	".veyyon/skills/tool-prompt-optimization/SKILL.md:28:scripts/probe-builtin.ts",
	"docs/context-files.md:66:.github/copilot-instructions.md",
	"docs/context-files.md:171:.github/copilot-instructions.md",
	"docs/context-files.md:230:.github/copilot-instructions.md",
	"docs/internal/toolconv/deepseek.md:101:assets/search_tool_trajectory.html",
	"packages/coding-agent/src/prompts/skills/user-invocation.md:8:scripts/foo.js",
	"website/blog/argot.md:12:packages/server/src/database/connection.ts",
	"website/blog/argot.md:43:packages/server/src/database/connection.ts",
]);

/** The baseline key for a finding: file, line, and the span exactly as written. */
export function baselineKey(dead: DeadPath): string {
	return `${dead.file}:${dead.line}:${dead.target}`;
}

export function checkDocPaths(rootDir: string, relFiles: string[]): PathCheckResult {
	const result: PathCheckResult = { filesChecked: 0, pathsChecked: 0, skippedInFence: 0, dead: [] };
	for (const rel of relFiles) {
		const abs = path.join(rootDir, rel);
		// Was a bare `catch { continue }`, which skipped a file for ANY reason -- including a permissions
		// error -- and reported a clean pass over a document nobody read. `readIfPresent` skips only a file
		// that has been deleted since it was listed (the index-vs-worktree race every doc walk here has) and
		// rethrows anything else.
		const markdown = readIfPresent(abs);
		if (markdown === undefined) continue;
		result.filesChecked += 1;
		for (const found of extractCodeSpanPaths(markdown)) {
			if (found.inFence) {
				result.skippedInFence += 1;
				continue;
			}
			result.pathsChecked += 1;
			const target = withoutLocator(found.target);
			if (resolvesFor(rootDir, rel, target)) continue;
			result.dead.push({
				file: rel,
				line: found.line,
				target: found.target,
				reason: "no such file or directory in the working tree",
			});
		}
	}
	// A doc naming a build output names something a clean checkout does not have,
	// which is the doc doing its job rather than rot. Asked once, in a batch,
	// after the scan, so the common case costs nothing.
	//
	// Both spellings are offered, the same two `resolvesFor` tries: a package
	// README naming its own build output writes it package-relative, and asking
	// only the root-relative form would report it as rot.
	const spellings = (d: DeadPath): string[] => {
		const target = withoutLocator(d.target);
		const pkg = enclosingPackage(d.file);
		return pkg === undefined ? [target] : [target, `${pkg}/${target}`];
	};
	const generated = ignoredPaths(rootDir, result.dead.flatMap(spellings));
	result.dead = result.dead.filter(d => !spellings(d).some(s => generated.has(s)));
	return result;
}

if (import.meta.main) {
	const rootDir = path.resolve(import.meta.dir, "..");
	const result = checkDocPaths(rootDir, listTrackedMarkdown(rootDir));
	const baseline = new Set(DEAD_PATH_BASELINE);
	const failures = result.dead.filter(d => !baseline.has(baselineKey(d)));
	const grandfathered = result.dead.length - failures.length;
	console.log(
		`checked ${result.pathsChecked} code-span source paths across ${result.filesChecked} markdown files ` +
			`(${result.skippedInFence} inside fenced blocks skipped, ${grandfathered} grandfathered)`,
	);
	// A baseline entry that no longer matches anything is reported, never ignored: a
	// list that quietly rots into a no-op is how a ratchet stops ratcheting.
	const matched = new Set(result.dead.map(baselineKey));
	for (const entry of DEAD_PATH_BASELINE) {
		if (!matched.has(entry)) console.log(`  stale-baseline: ${entry} (no longer dead; delete the entry)`);
	}
	if (failures.length > 0) {
		console.error(`\n${failures.length} doc path(s) naming a file that does not exist:`);
		for (const d of failures) console.error(`  ${d.file}:${d.line}: ${d.target} (${d.reason})`);
		process.exit(1);
	}
}
