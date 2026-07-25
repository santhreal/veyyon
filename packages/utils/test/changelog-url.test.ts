import { describe, expect, it } from "bun:test";
import { CHANGELOG_URL, changelogUrlForVersion } from "@veyyon/utils";

/**
 * `changelogUrlForVersion` is the single owner of the per-version changelog link
 * used by the rollback picker, the post-update tip hint, and any settings
 * surface. The anchor it builds MUST match the id the website emits for each
 * release (`website/tools/gen-changelog.mjs` writes `<h2 id="v1-0-12">`), or the
 * link lands on the page but not the version. These tests pin the exact format
 * so a drift on either side is caught immediately.
 */
describe("changelogUrlForVersion", () => {
	it("builds the website anchor by dot-to-dash on the bare version", () => {
		// 1.0.12 → …/changelog#v1-0-12, the exact id gen-changelog.mjs emits.
		expect(changelogUrlForVersion("1.0.12")).toBe(`${CHANGELOG_URL}#v1-0-12`);
	});

	it("strips a leading v so a tag and a bare version resolve identically", () => {
		// The release listing carries both `version` (1.0.11) and `tag` (v1.0.11);
		// either must produce the same anchor, never a double-v `#vv1-0-11`.
		expect(changelogUrlForVersion("v1.0.11")).toBe(`${CHANGELOG_URL}#v1-0-11`);
		expect(changelogUrlForVersion("v1.0.11")).toBe(changelogUrlForVersion("1.0.11"));
	});

	it("dashes every dot in a multi-digit version", () => {
		// Guards the global replace: a single-replace bug would leave 10.20.30 as
		// `#v10-20.30`, a dead anchor.
		expect(changelogUrlForVersion("10.20.30")).toBe(`${CHANGELOG_URL}#v10-20-30`);
	});
});
