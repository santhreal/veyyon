/**
 * Which directory the re-root hint names, when more than one qualifies at once.
 *
 * WHY THIS SUITE EXISTS. The detector credits a touched file to its directory AND to
 * each ancestor within a depth cap, so a single read makes several candidates, and a
 * call that touches several files (a multi-path grep, a glob, an apply-patch spanning
 * projects) can push several of them over the threshold in the same breath. Exactly
 * one hint is emitted, so something has to choose, and the choice is the whole value
 * of the feature: naming `/srv` when the work is under `/srv/thing` is technically
 * true and useless.
 *
 * The choice used to be "longest path STRING wins". Within one ancestor chain that is
 * accidentally right, since a child's path is always longer than its parent's, which
 * is why it survived. Between two unrelated trees it is arbitrary: the winner became a
 * function of how long the directory names happened to be, so `/srv/verylongname` beat
 * `/srv/a/b/c/d` while being four levels shallower. That is the "barely consistent"
 * half of this feature -- the same session shape gave different advice depending on
 * spelling.
 *
 * The rule is now depth in path segments, then evidence, then lexicographic so the
 * answer never depends on the order files happened to arrive. Each is pinned here,
 * along with the two ancestor-chain cases that must keep working.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { REROOT_FILE_THRESHOLD, RerootDetector } from "@veyyon/coding-agent/tools/reroot-hint";

const CWD = path.join(path.sep, "home", "dev", "launch");

/** `count` distinct files directly under `directory`. */
function filesUnder(directory: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => path.join(directory, `file-${index}.ts`));
}

/**
 * One call touching every path, which is how two candidates come to compete.
 *
 * Observing them one at a time would decide the question by ARRIVAL instead: the first
 * directory to reach the threshold is announced immediately, along with its ancestors,
 * and the ranking never runs. That is correct behaviour and not what this suite is
 * about.
 */
function observeTogether(files: string[]) {
	return new RerootDetector().observe(files, CWD);
}

describe("choosing between two unrelated candidate directories", () => {
	/**
	 * THE REGRESSION. Both trees qualify in the same call and the deeper one has the
	 * shorter name. Under the string-length rule the shallow long-named directory won,
	 * so the hint pointed at a less specific place than the one the detector knew about.
	 */
	it("names the deeper directory, not the one with the longer name", () => {
		const deep = path.join(path.sep, "srv", "a", "b", "c", "d");
		const shallowButLong = path.join(path.sep, "srv", "averyveryverylongprojectnamehere");

		const hint = observeTogether([
			...filesUnder(shallowButLong, REROOT_FILE_THRESHOLD),
			...filesUnder(deep, REROOT_FILE_THRESHOLD),
		]);

		expect(hint?.directory).toBe(deep);
	});

	/**
	 * At equal depth the two trees are genuinely unrelated, and the one the session
	 * spent more of itself in is the honest answer.
	 */
	it("breaks a depth tie by how much evidence each directory has", () => {
		const busy = path.join(path.sep, "srv", "busy");
		const glanced = path.join(path.sep, "srv", "glanced");

		const hint = observeTogether([...filesUnder(glanced, REROOT_FILE_THRESHOLD), ...filesUnder(busy, 6)]);

		expect(hint?.directory).toBe(busy);
		expect(hint?.fileCount).toBe(6);
	});

	/**
	 * Fully tied candidates must still produce ONE stable answer. Without a final
	 * tie-break the winner is whichever the underlying `Map` happened to hold first,
	 * which is a function of the order the paths arrived in -- so the same call with two
	 * paths swapped would give different advice.
	 */
	it("resolves a full tie the same way regardless of the order paths arrived", () => {
		const left = path.join(path.sep, "srv", "aaa");
		const right = path.join(path.sep, "srv", "bbb");
		const leftFirst = observeTogether([
			...filesUnder(left, REROOT_FILE_THRESHOLD),
			...filesUnder(right, REROOT_FILE_THRESHOLD),
		]);
		const rightFirst = observeTogether([
			...filesUnder(right, REROOT_FILE_THRESHOLD),
			...filesUnder(left, REROOT_FILE_THRESHOLD),
		]);

		expect(leftFirst?.directory).toBe(rightFirst?.directory);
		expect(leftFirst?.directory).toBe(left);
	});

	/**
	 * And the shared ancestor of two unrelated projects must never win, even though it
	 * holds the sum of both their evidence. It is the one candidate that is guaranteed
	 * to qualify whenever any child does, and re-rooting to it would make every path in
	 * both projects absolute again. This is why depth is compared BEFORE evidence.
	 */
	it("never names the common ancestor of two projects it holds the sum of", () => {
		const one = path.join(path.sep, "srv", "one");
		const two = path.join(path.sep, "srv", "two");

		const hint = observeTogether([
			...filesUnder(one, REROOT_FILE_THRESHOLD),
			...filesUnder(two, REROOT_FILE_THRESHOLD),
		]);

		expect(hint?.directory).not.toBe(path.join(path.sep, "srv"));
		expect([one, two]).toContain(hint?.directory ?? "no hint was emitted");
	});
});

describe("choosing within one ancestor chain", () => {
	/**
	 * The case the old rule got right, which must keep working: every ancestor of a
	 * qualifying directory is credited the SAME evidence keys, so the chain ties on
	 * count and the deepest member is the specific answer.
	 */
	it("names the deepest directory when the whole chain qualifies", () => {
		const leaf = path.join(path.sep, "srv", "project", "packages", "core", "src");

		const hint = observeTogether(filesUnder(leaf, REROOT_FILE_THRESHOLD));

		expect(hint?.directory).toBe(leaf);
	});

	/**
	 * Evidence spread across sibling directories accumulates on their shared parent, and
	 * that parent is then the right answer: no single leaf reaches the threshold, but the
	 * project plainly is the session's subject.
	 */
	it("names the shared parent when no single leaf reaches the threshold", () => {
		const project = path.join(path.sep, "srv", "project");

		const hint = observeTogether([
			path.join(project, "one", "a.ts"),
			path.join(project, "two", "b.ts"),
			path.join(project, "three", "c.ts"),
		]);

		expect(hint?.directory).toBe(project);
		expect(hint?.fileCount).toBe(REROOT_FILE_THRESHOLD);
	});
});
