#!/usr/bin/env bun
// Freshness gate for docs/internal: each doc may end with a machine-readable
// verification stamp, and once stamped, editing the doc without re-verifying
// it is an error. Unstamped docs are reported loudly (they read as
// "unverified") but do not fail the gate — stamping is earned by actually
// verifying a doc against the code, never backfilled blind.
//
// Stamp format (last non-empty line of the file):
//   *Verified against `<commit-sha>` on YYYY-MM-DD.*
//
// Gate rules for a stamped doc:
//   1. The stamped commit must exist in the repository.
//   2. The doc's last commit date must not be after the stamp date — if the
//      doc changed after it was verified, the stamp is stale and must be
//      renewed (or removed) in the same change.
//
// One edit cannot invalidate a verification: renaming another doc and rewriting
// the paths that point at it. The stamp asserts that this page's claims match
// the code at a commit, and where a sibling page lives says nothing about that.
// A docs reorganization used to go stale against every stamped page it touched,
// which turned 8 verified docs into "re-verify or drop the stamp" for a
// mechanical path rewrite. So rule 2 exempts a doc whose only change since the
// stamp was written is markdown path tokens (link targets, link text, code
// spans — anywhere a `foo/bar.md` appears). Any prose change still fails.
//
// A package move is the same edit one class wider: it rewrites the source paths inside every
// stamped page that points at it, and a page whose only change is `packages/tui/src/x.ts` becoming
// `hosts/terminal/engine/src/x.ts` still describes the same code. So the exemption also folds a
// token that NAMES SOMETHING IN THE TREE it is read against — the old path in the stamped
// snapshot's tree, the new path in the working tree. A rewrite pointing at a path that exists in
// neither is not a move, so it stays a difference and the stamp still has to be renewed.
//
// The baseline for that judgement is the commit that WROTE the current stamp,
// not the commit the stamp names: the stamp names the code it was verified
// against, and the doc at that code commit is usually a different, older page.
//
// CI gate: .github/workflows/docs.yml.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { readIfPresent } from "./check-doc-links";

export interface Stamp {
	sha: string;
	date: string;
}

export interface FreshnessIssue {
	file: string;
	reason: string;
}

export interface FreshnessResult {
	filesChecked: number;
	stamped: number;
	unstamped: string[];
	/** Tracked at HEAD but absent from the working tree (an in-flight rename/delete). */
	missing: string[];
	/** Edited after the stamp, but only in markdown path tokens — exempt, and named so the exemption is never silent. */
	pathRenamedOnly: string[];
	issues: FreshnessIssue[];
}

export const STAMP_PATTERN = /^\*Verified against `([0-9a-f]{7,40})` on (\d{4}-\d{2}-\d{2})\.\*$/;

/**
 * A last line that claims verification without being a stamp this gate can read.
 *
 * These are the dangerous ones. `*Verified against tree on 2026-07-21.*` and
 * `*Verified against the scroll-tape change on 2026-07-24.*` both read to a human
 * as "this page was checked", and both parse to null, so the gate filed them
 * under "unstamped" and waved them through — including after later edits that
 * would have failed a real stamp. Two docs sat in that blind spot. A claim the
 * gate cannot check is worse than no claim, so it is an error rather than a
 * silent pass.
 */
export const NEAR_MISS_PATTERN = /^\*?Verified against .*$/i;

/** Parse the verification stamp from a doc's last non-empty line, if any. */
export function parseStamp(markdown: string): Stamp | null {
	const lines = markdown.trimEnd().split("\n");
	const last = lines[lines.length - 1]?.trim() ?? "";
	const match = last.match(STAMP_PATTERN);
	return match ? { sha: match[1], date: match[2] } : null;
}

function git(root: string, args: string[]): { status: number; stdout: string } {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
	return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** Every markdown path token in a doc: `foo.md`, `../reference/models-yml.md`, `docs/internal/session.md`. */
export const MARKDOWN_PATH_TOKEN = /[\w./-]*[\w-]\.md/g;

/**
 * Fold away where other docs live, so two snapshots compare on what they claim.
 *
 * The tokens are replaced rather than stripped: a sentence that lost a path
 * still differs from one that had a path renamed.
 */
export function normalizeDocPaths(markdown: string): string {
	return markdown.replace(MARKDOWN_PATH_TOKEN, "@");
}

/**
 * Every token shaped like a path inside this repository: `packages/coding-agent/src/cli.ts`,
 * `natives/`, `hosts/terminal/engine`, or a glob over a directory's children. A token with no
 * slash in it is not a candidate, so ordinary prose never matches.
 */
export const REPO_PATH_TOKEN = /[\w@.-]+\/(?:[\w@.*+-]+\/?)*/g;

/**
 * The tracked paths of one tree, files and every directory above them.
 *
 * Read once per tree and reused, because the fold below asks about a few hundred tokens per doc
 * and a `git cat-file` apiece would cost more than the whole gate.
 */
export function trackedPaths(root: string, sha?: string): Set<string> {
	const listing = sha === undefined ? git(root, ["ls-files"]) : git(root, ["ls-tree", "-r", "--name-only", sha]);
	const known = new Set<string>();
	if (listing.status !== 0) return known;
	for (const file of listing.stdout.split("\n")) {
		if (file.length === 0) continue;
		known.add(file);
		for (let cut = file.lastIndexOf("/"); cut > 0; cut = file.lastIndexOf("/", cut - 1)) {
			known.add(file.slice(0, cut));
		}
	}
	return known;
}

/**
 * Fold away where CODE lives, on the same terms as where other docs live.
 *
 * A package move rewrites the paths inside every doc that points at it, and the stamp asserts that
 * this page's claims match the code — not which directory the code sits in, which the rewrite is
 * what keeps true. Folding is granted only for a token that NAMES SOMETHING IN THE TREE it is read
 * against, so a rewrite to a path that does not exist stays a difference and the gate still asks
 * for a re-verification. Prose is untouched: a token needs a slash to be a candidate at all.
 */
export function foldRepoPaths(markdown: string, known: Set<string>): string {
	return markdown.replace(REPO_PATH_TOKEN, token => {
		const bare = token.endsWith("/") ? token.slice(0, -1) : token;
		if (known.has(bare)) return "@";
		// A glob names a set of siblings; the directory holding them is what the token asserts.
		const parent = bare.slice(0, bare.lastIndexOf("/"));
		if (bare.includes("*") && parent.length > 0 && known.has(parent)) return "@";
		return token;
	});
}

function lastLine(markdown: string): string {
	const lines = markdown.trimEnd().split("\n");
	return lines[lines.length - 1]?.trim() ?? "";
}

/** The doc as it stood when its current stamp was written, with that commit's date. */
export interface StampedSnapshot {
	sha: string;
	date: string;
	markdown: string;
}

/**
 * The doc as it stood when its current stamp was written, or null when that
 * cannot be established (the stamp is uncommitted, or history is unreadable).
 *
 * Found by walking the file's commits newest-first while the stamp footer still
 * matches, and keeping the oldest match: that is the commit that introduced the
 * stamp, and every commit after it is an edit the stamp did not cover.
 */
export function stampedSnapshot(root: string, file: string, stamp: string): StampedSnapshot | null {
	const log = git(root, ["log", "--format=%H %cs", "--", file]);
	if (log.status !== 0) return null;
	let snapshot: StampedSnapshot | null = null;
	for (const line of log.stdout.split("\n").filter(Boolean)) {
		const [sha, date] = line.split(" ");
		if (!sha || !date) break;
		const show = git(root, ["show", `${sha}:${file}`]);
		if (show.status !== 0) break;
		if (lastLine(show.stdout) !== stamp) break;
		snapshot = { sha, date, markdown: show.stdout };
	}
	return snapshot;
}

export function checkFreshness(root: string, files: string[]): FreshnessResult {
	const result: FreshnessResult = {
		filesChecked: 0,
		stamped: 0,
		unstamped: [],
		missing: [],
		pathRenamedOnly: [],
		issues: [],
	};
	const currentTree = trackedPaths(root);
	const snapshotTrees = new Map<string, Set<string>>();
	const treeOf = (sha: string): Set<string> => {
		const cached = snapshotTrees.get(sha);
		if (cached !== undefined) return cached;
		const tree = trackedPaths(root, sha);
		snapshotTrees.set(sha, tree);
		return tree;
	};
	for (const file of files) {
		const abs = path.join(root, file);
		// `git ls-files` reports the index; a file deleted (or renamed away) in the
		// working tree but not yet committed would crash the read. That is tree
		// state, not doc staleness — surface it loudly and keep checking the rest.
		// One step rather than existsSync-then-read, because the tree can change in between; either way a
		// file that is not there is reported through `missing`, which is loud, instead of vanishing from the
		// count. Any other read failure still throws.
		const markdown = readIfPresent(abs);
		if (markdown === undefined) {
			result.missing.push(file);
			continue;
		}
		result.filesChecked++;
		const stamp = parseStamp(markdown);
		if (!stamp) {
			const lines = markdown.trimEnd().split("\n");
			const last = lines[lines.length - 1]?.trim() ?? "";
			if (NEAR_MISS_PATTERN.test(last)) {
				result.issues.push({
					file,
					reason:
						`ends with a verification claim this gate cannot read (${JSON.stringify(last)}), so edits to ` +
						"this doc were never checked against it. Use the exact form " +
						"*Verified against `<sha>` on YYYY-MM-DD.* after verifying the doc, or reword the line so it " +
						"does not claim verification",
				});
				continue;
			}
			result.unstamped.push(file);
			continue;
		}
		result.stamped++;
		if (git(root, ["cat-file", "-e", `${stamp.sha}^{commit}`]).status !== 0) {
			result.issues.push({ file, reason: `stamped commit ${stamp.sha} does not exist` });
			continue;
		}
		const lastEdit = git(root, ["log", "-1", "--format=%cs", "--", file]).stdout.trim();
		if (lastEdit && lastEdit > stamp.date) {
			// The exemption needs a snapshot the stamp actually covers: a stamping
			// commit no later than the stamp date. A stamp written after the date it
			// claims is backdated, and comparing the doc against the commit that
			// backdated it would certify the edit with itself.
			const snapshot = stampedSnapshot(root, file, lastLine(markdown));
			// Each side is folded against ITS OWN tree, so a path that existed then and a path that
			// exists now both read as "a path", while a path naming nothing in either tree does not.
			if (
				snapshot !== null &&
				snapshot.date <= stamp.date &&
				foldRepoPaths(normalizeDocPaths(snapshot.markdown), treeOf(snapshot.sha)) ===
					foldRepoPaths(normalizeDocPaths(markdown), currentTree)
			) {
				result.pathRenamedOnly.push(file);
				continue;
			}
			result.issues.push({
				file,
				reason: `doc last edited ${lastEdit}, after its ${stamp.date} verification stamp — re-verify and re-stamp (or drop the stamp)`,
			});
		}
	}
	return result;
}

export function listInternalDocs(root: string): string[] {
	const ls = git(root, ["ls-files", "docs/internal/**/*.md", "docs/internal/*.md"]);
	if (ls.status !== 0) throw new Error("git ls-files failed");
	return [...new Set(ls.stdout.split("\n").filter(Boolean))];
}

if (import.meta.main) {
	const root = path.resolve(import.meta.dir, "..");
	const result = checkFreshness(root, listInternalDocs(root));
	console.log(
		`checked ${result.filesChecked} internal docs: ${result.stamped} stamped, ${result.unstamped.length} unverified (no stamp)`,
	);
	for (const file of result.unstamped) {
		console.log(`  unverified: ${file}`);
	}
	for (const file of result.missing) {
		console.log(`  MISSING from working tree (tracked at HEAD — in-flight delete/rename?): ${file}`);
	}
	for (const file of result.pathRenamedOnly) {
		console.log(`  stamp kept across a doc-path rename (no prose change since it was written): ${file}`);
	}
	if (result.issues.length > 0) {
		console.error(`\n${result.issues.length} stale/broken stamp(s):`);
		for (const issue of result.issues) {
			console.error(`  ${issue.file}: ${issue.reason}`);
		}
		process.exit(1);
	}
}
