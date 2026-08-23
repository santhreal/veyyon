/**
 * Every third-party GitHub Action this repository uses resolves to one commit.
 *
 * WHY THIS SUITE EXISTS. Actions are pinned by commit sha here, which is the right
 * call — a tag is mutable and an action runs with the workflow's token. The cost is
 * arithmetic: `actions/checkout` is written out 35 times, `oven-sh/setup-bun` 10, and
 * a bump is a find-and-replace nobody can verify by reading one diff. Some jobs
 * deliberately call `oven-sh/setup-bun` directly instead of routing through
 * `.github/actions/bun-install`, to skip the install latency, which multiplies the
 * copies rather than reducing them.
 *
 * A partial bump is the failure this prevents, and it is the quiet kind: half the
 * jobs run one revision of an action and half run another, both succeed, and the two
 * differ in exactly the behavior somebody bumped the action to change.
 *
 * THE CLASS this closes: a second revision of one action inside `.github/**`. Every
 * `uses:` line in every workflow and composite action is read off disk and grouped by
 * owner, so a new file carrying a stale sha is red on arrival, and so is a bump that
 * misses a copy.
 *
 * WHAT IT DOES NOT CATCH. A sha that is consistent everywhere and simply wrong —
 * nothing here knows which revision of an action is good, only that the tree agrees
 * on one. It says nothing about the version comment beside the sha being accurate
 * (a stale `# v2.2.0` next to the right commit is cosmetic), and it does not read
 * action references from anywhere but `.github/**`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GITHUB_DIR = path.join(REPO_ROOT, ".github");

interface Reference {
	/** `owner/repo` or `owner/repo/subdir`, which is the unit a sha pins. */
	action: string;
	ref: string;
	file: string;
	line: number;
}

/** `uses: owner/repo[/path]@ref`, ignoring local `./.github/actions/...` references. */
const USES = /^\s*-?\s*uses:\s*([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?)@(\S+)/;

function references(): Reference[] {
	const found: Reference[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
			const relative = path.relative(REPO_ROOT, full);
			fs.readFileSync(full, "utf8")
				.split("\n")
				.forEach((text, index) => {
					const match = USES.exec(text);
					if (match) found.push({ action: match[1], ref: match[2], file: relative, line: index + 1 });
				});
		}
	};
	walk(GITHUB_DIR);
	return found;
}

const all = references();

function byAction(): Map<string, Reference[]> {
	const grouped = new Map<string, Reference[]>();
	for (const reference of all) {
		const existing = grouped.get(reference.action);
		if (existing) existing.push(reference);
		else grouped.set(reference.action, [reference]);
	}
	return grouped;
}

const grouped = byAction();

describe("a third-party action is pinned in one place", () => {
	it("reads the references off disk, across workflows and composite actions", () => {
		// The corpus every case below depends on. A walk that found nothing, or only
		// workflows, would otherwise pass every equality check vacuously.
		expect(all.length).toBeGreaterThan(20);
		expect(new Set(all.map(r => r.file.split("/")[1]))).toEqual(new Set(["workflows", "actions"]));
	});

	for (const [action, uses] of grouped) {
		it(`${action} resolves to one revision`, () => {
			const distinct = [...new Set(uses.map(u => u.ref))];
			// The failure message has to name the outliers, or a 35-copy action tells
			// you two shas exist and nothing about which file to open.
			const sites = uses.map(u => `${u.file}:${u.line} @${u.ref}`);
			expect(distinct.length === 1 ? [] : sites).toEqual([]);
		});
	}

	it("pins by commit sha, never by tag or branch", () => {
		// A tag is mutable, so a tag-pinned action is an unreviewed commit running
		// with this workflow's token. Reported as the offending sites, not a count.
		const notASha = all.filter(r => !/^[0-9a-f]{40}$/.test(r.ref)).map(r => `${r.file}:${r.line} @${r.ref}`);
		expect(notASha).toEqual([]);
	});
});
