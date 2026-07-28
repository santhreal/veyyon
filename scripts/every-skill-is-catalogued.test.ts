import { describe, expect, it } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

/**
 * Every maintainer skill is listed in `.veyyon/skills/INDEX.md`, and every entry
 * in that index points at a skill that exists.
 *
 * WHY THIS SUITE EXISTS. A skill directory is only reachable through the index:
 * nothing scans the directory at runtime, so a `SKILL.md` that no table row
 * links to is a document that exists and is never opened. Three of them were in
 * exactly that state (`system-prompts`, `tool-prompt-optimization`,
 * `semantic-compression`), named in a sentence of prose as owner-maintained but
 * carrying no link, which reads as "these are documented elsewhere" rather than
 * "these are here and nobody catalogued them". The failure is silent in both
 * directions: an uncatalogued skill is never found, and an index row pointing at
 * a deleted directory sends a reader to a 404 while the index still looks
 * complete.
 *
 * The check is deliberately about CATALOGUING, not about which table a skill
 * belongs in. Owner-maintained skills are not part of the ship ritual and must
 * not be routed to by `ship-feature`; they still have to be findable, so the
 * index has a second table for them and both count here.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SKILLS_DIR = path.join(REPO_ROOT, ".veyyon", "skills");
const INDEX_PATH = path.join(SKILLS_DIR, "INDEX.md");

/** Directory names under `.veyyon/skills/` that contain a `SKILL.md`. */
async function skillDirectories(): Promise<string[]> {
	const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
	const found: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skill = path.join(SKILLS_DIR, entry.name, "SKILL.md");
		const exists = await stat(skill).then(
			() => true,
			() => false,
		);
		if (exists) found.push(entry.name);
	}
	return found.sort();
}

const INDEX = await readFile(INDEX_PATH, "utf8");
const SKILL_DIRS = await skillDirectories();

/** Every `](<dir>/SKILL.md)` target the index links, as directory names. */
function linkedSkills(): string[] {
	const linked = new Set<string>();
	for (const match of INDEX.matchAll(/\]\(([^)]+)\/SKILL\.md\)/g)) linked.add(match[1]);
	return [...linked].sort();
}

describe("the maintainer skills index", () => {
	/**
	 * Guard on the guard: both assertions below compare two lists, and two empty
	 * lists are equal. If the directory walk or the link regex stopped matching,
	 * this suite would pass while checking nothing.
	 */
	it("finds real skills and real links", () => {
		expect(SKILL_DIRS.length).toBeGreaterThanOrEqual(10);
		expect(SKILL_DIRS).toContain("ship-feature");
		expect(linkedSkills().length).toBeGreaterThanOrEqual(10);
	});

	/**
	 * Every skill directory is linked from the index.
	 *
	 * Asserted as the whole sorted list rather than per-directory, so the failure
	 * message names exactly which skills are missing instead of stopping at the
	 * first one.
	 */
	it("links every skill directory that has a SKILL.md", () => {
		expect(linkedSkills()).toEqual(SKILL_DIRS);
	});

	/**
	 * And nothing else. A row left behind by a deleted skill points at a file
	 * that is not there, which the index cannot show and a reader only discovers
	 * by clicking.
	 */
	it("has no row pointing at a skill that does not exist", () => {
		const dangling = linkedSkills().filter(name => !SKILL_DIRS.includes(name));
		expect(dangling).toEqual([]);
	});

	/**
	 * Each linked target resolves on disk, which is the check a name comparison
	 * cannot make: a row could name a real directory and still spell the file
	 * inside it wrong.
	 */
	it("resolves every linked SKILL.md path", async () => {
		for (const name of linkedSkills()) {
			const target = path.join(SKILLS_DIR, name, "SKILL.md");
			const exists = await stat(target).then(
				() => true,
				() => false,
			);
			expect(exists, `${name}/SKILL.md is linked from INDEX.md but missing`).toBe(true);
		}
	});

	/**
	 * The owner-maintained skills stay out of the ship ritual's table.
	 *
	 * Cataloguing them was the fix, and the obvious way to over-apply it is to
	 * fold them into the router's list, which would tell an agent landing a
	 * change to go compress prompts. They belong in their own section, and this
	 * pins that they are below the "Owner-maintained" heading rather than above
	 * it.
	 */
	it("keeps the owner-maintained skills in their own section", () => {
		const ownerHeading = INDEX.indexOf("## Owner-maintained");
		expect(ownerHeading).toBeGreaterThan(0);
		const ritual = INDEX.slice(0, ownerHeading);
		for (const ownerOnly of ["system-prompts", "tool-prompt-optimization", "semantic-compression"]) {
			expect(ritual).not.toContain(`](${ownerOnly}/SKILL.md)`);
			expect(INDEX.slice(ownerHeading)).toContain(`](${ownerOnly}/SKILL.md)`);
		}
	});
});
