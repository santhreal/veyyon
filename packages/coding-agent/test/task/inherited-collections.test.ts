import { describe, expect, it, vi } from "bun:test";
import {
	inheritResolvedCollection,
	resolveAutoloadSkills,
	settleAutoloadSkills,
} from "@veyyon/coding-agent/task/inherited-collections";
import { logger } from "@veyyon/utils";

/**
 * Capture `logger.warn` for the duration of `body`, restoring the spies either way.
 *
 * `logger.debug` is stubbed alongside it, not because these cases assert on it, but because a real
 * debug write here re-binds the file transport and trips the real-data guard once an earlier
 * fixture-based file has moved the config root out from under it.
 */
function withSilencedLogger<T>(body: (warnings: Array<{ message: string; fields: Record<string, unknown> }>) => T): T {
	const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const warnSpy = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
	const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
	try {
		return body(warnings);
	} finally {
		warnSpy.mockRestore();
		debugSpy.mockRestore();
	}
}

/**
 * THE PRODUCER HALF of "an empty collection must not read as already resolved".
 *
 * `skills`, `promptTemplates`, and `rules` reach a spawned session as `T[] | undefined`, and
 * `sdk.ts` switches on PRESENCE (`if (options.skills !== undefined)`), skipping discovery for
 * anything that arrived, empty arrays included. Every spawn site used to write
 * `[...(session.skills ?? [])]` or forward the parent's array verbatim, so a parent that had not
 * resolved a layer, or had resolved it to zero items, told the child "resolved, do not look".
 */
describe("inheritResolvedCollection", () => {
	/**
	 * LOCKS OUT: `[...(session.skills ?? [])]` at `task/index.ts`, `eval/agent-bridge.ts`, and
	 * `vibe/runtime.ts`.
	 *
	 * IF THIS REGRESSES: a subagent spawned by a parent with no skills loaded can never load a skill
	 * of its own for the whole session, without a single warning anywhere. Prompt templates and
	 * rules ride the identical switch and fail the same way.
	 */
	it("forwards undefined for an unresolved or empty parent layer", () => {
		const sameCwd = { parentCwd: "/repo", spawnCwd: "/repo", agentName: "reviewer" } as const;
		withSilencedLogger(() => {
			expect(inheritResolvedCollection({ items: undefined, kind: "skills", ...sameCwd })).toBeUndefined();
			expect(inheritResolvedCollection({ items: [], kind: "skills", ...sameCwd })).toBeUndefined();
			expect(inheritResolvedCollection({ items: [], kind: "promptTemplates", ...sameCwd })).toBeUndefined();
			expect(inheritResolvedCollection({ items: [], kind: "rules", ...sameCwd })).toBeUndefined();
		});
	});

	/**
	 * LOCKS OUT: the missing spawn-cwd guard on skills, promptTemplates, and rules at
	 * `task/index.ts`, which forwarded the parent's lists to a `task(cwd: other)` child.
	 *
	 * IF THIS REGRESSES: all three layers are cwd-discovered (skills from `discoverSkills(cwd, ...)`
	 * and project `.veyyon/skills`, prompt templates from `<cwd>/.veyyon/prompts`, rules from
	 * `loadCapability("rules", { cwd })`), and presence disables discovery, so a child pointed at
	 * another tree runs on the parent tree's skills and rules and never loads the ones that belong
	 * to the tree it was pointed at. This is the shape of the defect that cost every spawned agent
	 * its `AGENTS.md`; `context-inheritance.ts` already refuses this for context files.
	 */
	it("refuses to inherit any layer across a spawn-cwd change", () => {
		const parent = [{ name: "review" }];
		withSilencedLogger(() => {
			for (const kind of ["skills", "promptTemplates", "rules"] as const) {
				expect(
					inheritResolvedCollection({
						items: parent,
						kind,
						parentCwd: "/repo",
						spawnCwd: "/other-repo",
						agentName: "reviewer",
					}),
				).toBeUndefined();
			}
		});
	});

	/** A cwd that differs only in spelling is the SAME root, so it must still inherit. */
	it("treats an unnormalized but identical cwd as the same root", () => {
		const parent = [{ name: "review" }];
		const inherited = withSilencedLogger(() =>
			inheritResolvedCollection({
				items: parent,
				kind: "skills",
				parentCwd: "/repo",
				spawnCwd: "/repo/sub/..",
				agentName: "reviewer",
			}),
		);

		expect(inherited).toEqual(parent);
	});

	/**
	 * LOCKS OUT: an over-eager version of the fix that also refuses to inherit a real list, which
	 * would make every spawn re-scan the filesystem for layers the parent already holds.
	 */
	it("passes a non-empty parent layer through as an independent copy", () => {
		const parent = [{ name: "review" }, { name: "ship" }];
		const inherited = withSilencedLogger(() =>
			inheritResolvedCollection({
				items: parent,
				kind: "skills",
				parentCwd: "/repo",
				spawnCwd: "/repo",
				agentName: "reviewer",
			}),
		);

		expect(inherited).toEqual(parent);
		expect(inherited).not.toBe(parent);
	});
});

describe("resolveAutoloadSkills", () => {
	/**
	 * LOCKS OUT: `autoloadSkills` names silently disappearing. The old spelling was
	 * `.map(find).filter(defined)`, so a typo in an agent's frontmatter, or a skill that failed to
	 * load, produced a shorter list and no signal: the agent started without the skill it declares
	 * it needs and nothing said why.
	 */
	it("reports declared names that match no loaded skill", () => {
		const available = [{ name: "review" }, { name: "ship" }];
		const { plan, warnings } = withSilencedLogger(captured => ({
			plan: resolveAutoloadSkills(["review", "missing-one", "also-missing"], available, "reviewer"),
			warnings: captured,
		}));

		expect(plan).toEqual({ kind: "resolved", skills: [{ name: "review" }] });
		expect(warnings).toEqual([
			{
				message: "Agent declares autoloadSkills that no loaded skill matches; those skills will not load",
				fields: { agent: "reviewer", missing: ["missing-one", "also-missing"], availableCount: 2 },
			},
		]);
	});

	/** An agent whose declarations all resolve stays quiet, so the warning above keeps its meaning. */
	it("stays silent when every declared name resolves", () => {
		const { plan, warnings } = withSilencedLogger(captured => ({
			plan: resolveAutoloadSkills(["review"], [{ name: "review" }], "reviewer"),
			warnings: captured,
		}));

		expect(plan).toEqual({ kind: "resolved", skills: [{ name: "review" }] });
		expect(warnings).toEqual([]);
	});

	/**
	 * LOCKS OUT: `resolveAutoloadSkills(agent.autoloadSkills, session.skills ?? [], name)`.
	 *
	 * That `??` collapsed "nobody resolved a skill set here" (`undefined`) into "the resolved set is
	 * empty" (`[]`), the exact distinction `inheritResolvedCollection` above exists to preserve. With
	 * it in place, every spawn from a session whose skills were never resolved produced the warning
	 * asserted in the FIRST case below, telling the operator their declared `autoloadSkills` would
	 * not load and naming a cause ("no loaded skill matches") that was not the real one. The names
	 * had not failed to match anything; there was nothing to match them against yet.
	 *
	 * IF THIS REGRESSES: a loud, wrong warning at every spawn, which is worse than the silence it
	 * replaced because it points at the operator's frontmatter instead of at the missing resolution.
	 *
	 * The empty case is deliberately the opposite ruling: `[]` IS a resolved set (`--no-skills`, or a
	 * scope holding nothing), so a declared name matching nothing in it is real news.
	 */
	it("defers instead of warning when no skill set was resolved, and warns when the set is empty", () => {
		const { deferred, empty, warnings } = withSilencedLogger(captured => ({
			deferred: resolveAutoloadSkills(["review"], undefined, "reviewer"),
			empty: resolveAutoloadSkills<{ name: string }>(["review"], [], "reviewer"),
			warnings: captured,
		}));

		expect(deferred).toEqual({ kind: "deferred", names: ["review"] });
		expect(empty).toEqual({ kind: "resolved", skills: [] });
		expect(warnings).toEqual([
			{
				message: "Agent declares autoloadSkills that no loaded skill matches; those skills will not load",
				fields: { agent: "reviewer", missing: ["review"], availableCount: 0 },
			},
		]);
	});

	/**
	 * The child half of the same contract: a `deferred` plan is judged against the set the CHILD
	 * resolved, which for a differing-`spawnCwd` spawn is the only set that can contain the skill.
	 */
	it("settles a deferred plan against the child's own skills", () => {
		const { settled, warnings } = withSilencedLogger(captured => ({
			settled: settleAutoloadSkills({ kind: "deferred", names: ["beta-skill"] }, [{ name: "beta-skill" }], "task"),
			warnings: captured,
		}));

		expect(settled).toEqual([{ name: "beta-skill" }]);
		expect(warnings).toEqual([]);
	});
});
