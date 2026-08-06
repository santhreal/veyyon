/**
 * One `Skill` type name per package.
 *
 * WHY: `capability/skill.ts` and `extensibility/skills.ts` both exported an interface called
 * `Skill`, from the same package, and the two shapes share only `name` and `_source`. The
 * capability one is the file as discovery loads it (whole markdown `content`, `path`,
 * `level`); the extensibility one is the session-facing summary (`description`, `filePath`,
 * `baseDir`, `source`). `@veyyon/coding-agent` served the summary, while
 * `@veyyon/coding-agent/discovery` and `@veyyon/coding-agent/capability/skill` served the
 * record, so code touching nothing but `name`/`_source` type-checked against either and could
 * read the wrong provenance with no error anywhere. The discovery record is now
 * `DiscoveredSkill`, named the way `capability/tool.ts` names `DiscoveredCustomTool`.
 *
 * Two kinds of check, because the contract is partly a type property and partly a runtime one:
 *
 * 1. Type-level, in the uncalled function below and checked by tsgo over the test tree. The
 *    two shapes must stay mutually unassignable, and neither module may export a type named
 *    `Skill` that is really the other one. If the shapes converged, or the record came back
 *    under the summary's name, the `@ts-expect-error` lines would have nothing to report and
 *    tsgo would fail on the unused directives.
 * 2. Runtime, over the real loader: what discovery produces carries the record's fields and
 *    none of the summary's, which is what makes the two names genuinely different things.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@veyyon/coding-agent/capability/fs";
import type { DiscoveredSkill } from "@veyyon/coding-agent/capability/skill";
// @ts-expect-error the discovery barrel exports the record as `DiscoveredSkill`. A type named
// `Skill` reachable from here is the second owner this fix removed: it would be the record,
// while `@veyyon/coding-agent` serves the summary under that same name.
import type { Skill as SkillFromDiscoveryBarrel } from "@veyyon/coding-agent/discovery";
import { scanSkillsFromDir } from "@veyyon/coding-agent/discovery/helpers";
import type { Skill as SessionSkill } from "@veyyon/coding-agent/extensibility/skills";
import { removeSyncWithRetries } from "@veyyon/utils";

// --- Type-level lock (checked by tsgo, never executed) -----------------------
function _skillOwnershipTypeContract(discovered: DiscoveredSkill, session: SessionSkill): void {
	// @ts-expect-error the discovery record has no `description`, `filePath` or `baseDir`
	const asSession: SessionSkill = discovered;
	// @ts-expect-error the session summary has no `content`, `path` or `level`
	const asDiscovered: DiscoveredSkill = session;
	void asSession;
	void asDiscovered;
	void (undefined as unknown as SkillFromDiscoveryBarrel);
}
void _skillOwnershipTypeContract;

describe("one Skill type per package", () => {
	let tempDir!: string;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-type-owner-"));
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	test("the discovery loader produces the record shape, not the session summary shape", async () => {
		const skillsDir = path.join(tempDir, "skills", "alpha");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: alpha\ndescription: An alpha skill.\n---\n\nBody of alpha.\n",
		);

		const result = await scanSkillsFromDir({
			dir: path.join(tempDir, "skills"),
			providerId: "native",
			level: "user",
		});

		expect(result.items).toHaveLength(1);
		const [skill] = result.items;
		expect(skill.name).toBe("alpha");
		expect(skill.level).toBe("user");
		expect(skill.path).toBe(path.join(skillsDir, "SKILL.md"));
		expect(skill.content).toContain("Body of alpha.");
		expect(skill.frontmatter?.description).toBe("An alpha skill.");
		// The summary's fields belong to the other owner and must not appear here, or the two
		// shapes are converging back into one name's worth of ambiguity.
		expect(Object.keys(skill).sort()).toEqual(["_source", "content", "frontmatter", "level", "name", "path"]);
	});
});
