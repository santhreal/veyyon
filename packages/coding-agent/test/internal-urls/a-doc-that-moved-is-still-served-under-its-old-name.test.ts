/**
 * A `veyyon://` reference survives the page moving inside `docs/`.
 *
 * WHY THIS SUITE EXISTS. Every user-facing page was folded into the handbook, so 31 files changed
 * path in one commit: `docs/secrets.md` became `docs/handbook/src/architecture/secrets.md`,
 * `docs/rpc.md` became `docs/handbook/src/reference/rpc.md`, and so on. References to those paths
 * do not all move with them. A prompt, a code comment, a released changelog entry that must not be
 * edited, an operator's shell history and the model's own memory of the tree all carry the old
 * spelling, and `veyyon://` resolved by exact path only, so each one answered "Documentation file
 * not found" for a page that is still in the binary.
 *
 * THE CLASS, not the incident: a reorganization must not invalidate a reference to a page that
 * still exists. The rule is basename resolution with ambiguity treated as a miss, which is what
 * makes it safe: an unambiguous name is served, and a name two pages share falls through to the
 * suggestion list rather than picking one.
 *
 * WHAT IT DOES NOT CATCH: a page that was deleted rather than moved, or a reference in prose that
 * a human reads instead of the protocol. Those are the doc-path gates' job
 * (`scripts/check-doc-paths.ts`).
 */
import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls";
import { getDocFilenames } from "@veyyon/coding-agent/internal-urls/docs-index";

const router = InternalUrlRouter.instance();

/** Every basename that exactly one page in the tree carries, which is the resolvable set. */
function uniqueBasenames(): Map<string, string> {
	const byName = new Map<string, string[]>();
	for (const file of getDocFilenames()) {
		const name = file.split("/").at(-1) ?? file;
		byName.set(name, [...(byName.get(name) ?? []), file]);
	}
	const unique = new Map<string, string>();
	for (const [name, files] of byName) if (files.length === 1) unique.set(name, files[0]);
	return unique;
}

describe("a doc reference that names the right page in the wrong directory", () => {
	/**
	 * Driven from the tree at run time rather than from a list of the pages this change moved: the
	 * next reorganization moves different pages, and a hardcoded list would go stale in silence.
	 * Every uniquely-named page is asserted, so a page that becomes unreachable by name fails here.
	 */
	it("serves every uniquely named page under its bare name", async () => {
		const unique = uniqueBasenames();

		expect(unique.size).toBeGreaterThan(100);
		const unreachable: string[] = [];
		for (const [name, full] of unique) {
			if (name === full) continue; // Already at the root; the exact lookup owns it.
			const byName = await router.resolve(`veyyon://${name}`).catch(() => undefined);
			const byPath = await router.resolve(`veyyon://${full}`);
			if (byName?.content !== byPath.content) unreachable.push(name);
		}
		expect(unreachable).toEqual([]);
	});

	/** The specific paths this reorganization broke, spelled the way an old reference spells them. */
	it("serves a page that moved into the handbook under its former flat path", async () => {
		for (const [old, moved] of [
			["veyyon://docs/rpc.md", "veyyon://docs/handbook/src/reference/rpc.md"],
			["veyyon://docs/theme.md", "veyyon://docs/handbook/src/reference/theme.md"],
			["veyyon://docs/keybindings-config.md", "veyyon://docs/handbook/src/reference/keybindings-config.md"],
			["veyyon://docs/context-files.md", "veyyon://docs/handbook/src/context/context-files.md"],
		] as const) {
			const before = await router.resolve(old);
			const after = await router.resolve(moved);

			expect(before.content, `${old} did not resolve`).toBe(after.content);
		}
	});

	/**
	 * AMBIGUITY IS A MISS. A topic that has both a guide and an internals page carries the same
	 * basename twice -- `secrets.md` is `features/secrets.md` and `architecture/secrets.md` -- and
	 * serving either one silently answers a question that was not asked: the reader cannot tell
	 * which of the two they got, and the two say different things about the same subsystem. The
	 * refusal names both, so one more character of the path is enough to choose.
	 */
	it("refuses a bare name that several pages carry, and names both candidates", async () => {
		const shared = getDocFilenames().filter(f => f.split("/").at(-1) === "secrets.md");

		expect(shared.length).toBeGreaterThan(1);
		const refusal = await router.resolve("veyyon://docs/secrets.md").then(
			() => "resolved, which hides which page answered",
			(error: Error) => error.message,
		);
		expect(refusal).toContain("Did you mean");
		for (const page of shared) expect(refusal).toContain(page);
	});

	/** A name no page carries is still a plain miss, with the listing offered. */
	it("refuses a name that no page carries", async () => {
		await expect(router.resolve("veyyon://nowhere-at-all.md")).rejects.toThrow(/not found/);
	});

	/** An exact path still wins, so basename resolution cannot shadow a page that is really there. */
	it("prefers the exact path over a same-named page elsewhere", async () => {
		const exact = await router.resolve("veyyon://tools/read.md");

		expect(exact.content).toContain("# read");
	});
});
