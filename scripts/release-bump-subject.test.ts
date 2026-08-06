/**
 * The release bump commit's subject line, which several workflows parse.
 *
 * WHY THESE TESTS. Every release up to and including v1.0.38 committed
 * `chore: bump version to 1.0.38` while AGENTS.md mandates
 * `chore: bump version to v1.0.38`. Nothing caught it for the whole tag
 * history, because the only machine readers of this subject are five workflows
 * that test the PREFIX `chore: bump version to ` — a prefix both forms satisfy.
 * So the defect was invisible to CI and visible only to a human reading a tag
 * list, and nothing in the pipeline compared the committed subject against the
 * mandated one. This file is that comparison.
 *
 * These tests pin both halves of the contract at once: the exact mandated form,
 * and the prefix property the workflows actually depend on. Pinning only the
 * exact string would let a future edit satisfy this file while breaking the
 * never-cancel release concurrency group (#2564), which is the failure that
 * leaves a tag on origin with no GitHub release.
 */
import { describe, expect, it } from "bun:test";
import { releaseBumpSubject } from "./release";

/** The literal prefix `checks.yml` exempts from the changelog gate. */
const WORKFLOW_PREFIX = "chore: bump version to ";

describe("release bump commit subject", () => {
	/**
	 * The mandated form, byte for byte. This is the assertion that would have
	 * failed on every release the project has ever cut.
	 */
	it("spells the version with the mandated v prefix", () => {
		expect(releaseBumpSubject("1.0.39")).toBe("chore: bump version to v1.0.39");
	});

	/**
	 * The bare form is the bug, stated as its own assertion so a regression
	 * cannot pass by accident: dropping the `v` must not merely differ from the
	 * expected string, it must produce exactly the subject that shipped broken.
	 */
	it("never emits the bare X.Y.Z form that shipped through v1.0.38", () => {
		const subject = releaseBumpSubject("1.0.38");
		expect(subject).not.toBe("chore: bump version to 1.0.38");
		expect(subject).toBe("chore: bump version to v1.0.38");
	});

	/**
	 * Idempotent on an already-prefixed version. The cutter is called with a bare
	 * version today, but a caller passing `v1.2.3` must not produce `vv1.2.3`,
	 * which would break the prefix consumers' version parsing and read as a
	 * different release.
	 */
	it("does not double the v when handed an already-prefixed version", () => {
		expect(releaseBumpSubject("v1.2.3")).toBe("chore: bump version to v1.2.3");
	});

	/**
	 * The property the five workflows actually depend on. If this breaks, release
	 * runs rejoin the branch-wide concurrency group and a later push to main
	 * cancels the in-flight release, stranding the tag with no GitHub release.
	 */
	it("keeps the prefix every release workflow matches on", () => {
		for (const version of ["1.0.39", "2.0.0", "10.20.30", "v1.2.3"]) {
			expect(releaseBumpSubject(version).startsWith(WORKFLOW_PREFIX)).toBe(true);
		}
	});

	/**
	 * `checks.yml` skips the changelog gate for the bump commit by matching this
	 * prefix on the head commit subject. A subject that stopped matching would
	 * fail every release on the one commit that legitimately drains every
	 * `## [Unreleased]` section and adds no new entry.
	 */
	it("is recognised by the loop guard that stops a release releasing itself", () => {
		const headCommitSubject = releaseBumpSubject("1.0.39");
		expect(headCommitSubject.startsWith(WORKFLOW_PREFIX)).toBe(true);
	});

	/**
	 * Multi-digit and multi-component versions keep the exact shape, so the
	 * version is recoverable from the subject by stripping the prefix and one
	 * leading `v` — which is what a human reading a tag list does, and what any
	 * consumer of `releaseBumpSubject` in `scripts/release.ts` may rely on.
	 */
	it("round-trips the version back out of the subject", () => {
		for (const version of ["1.0.39", "10.20.30", "2.0.0"]) {
			const recovered = releaseBumpSubject(version).slice(WORKFLOW_PREFIX.length).replace(/^v/, "");
			expect(recovered).toBe(version);
		}
	});
});
