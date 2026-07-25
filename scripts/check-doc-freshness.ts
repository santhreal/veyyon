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
// CI gate: .github/workflows/docs.yml.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

export function checkFreshness(root: string, files: string[]): FreshnessResult {
	const result: FreshnessResult = { filesChecked: 0, stamped: 0, unstamped: [], missing: [], issues: [] };
	for (const file of files) {
		const abs = path.join(root, file);
		// `git ls-files` reports the index; a file deleted (or renamed away) in the
		// working tree but not yet committed would crash the read. That is tree
		// state, not doc staleness — surface it loudly and keep checking the rest.
		if (!fs.existsSync(abs)) {
			result.missing.push(file);
			continue;
		}
		result.filesChecked++;
		const markdown = fs.readFileSync(abs, "utf-8");
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
	if (result.issues.length > 0) {
		console.error(`\n${result.issues.length} stale/broken stamp(s):`);
		for (const issue of result.issues) {
			console.error(`  ${issue.file}: ${issue.reason}`);
		}
		process.exit(1);
	}
}
