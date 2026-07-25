/**
 * `changelogUrlForVersion` must produce the anchor the website actually emits.
 *
 * Three surfaces link a specific version (the post-update hint, the rollback
 * picker's per-row changelog, and release tooling), and a wrong anchor does not
 * fail: the browser silently lands at the top of the changelog page. That is the
 * worst kind of bug for a link, because it looks like it worked. So these tests
 * pin the exact string rather than asserting it merely contains the version.
 *
 * The format is owned by `website/tools/gen-changelog.mjs`, which writes
 * `<h2 id="v1-2-3">` for version `1.2.3`. If that generator ever changes its
 * anchor scheme, this suite is the thing that says so.
 */
import { describe, expect, it } from "bun:test";
import { CHANGELOG_URL, changelogUrlForVersion } from "@veyyon/utils";

describe("changelogUrlForVersion", () => {
	it("builds the dashed anchor the changelog generator emits", () => {
		expect(changelogUrlForVersion("1.2.3")).toBe("https://veyyon.dev/changelog#v1-2-3");
	});

	it("tolerates a leading v, since callers hold versions both ways", () => {
		// `ReleaseInfo.tag` is "v1.2.3" while `ReleaseInfo.version` is "1.2.3".
		// Producing "#vv1-2-3" for one of them would be a dead link that still
		// loads a page.
		expect(changelogUrlForVersion("v1.2.3")).toBe(changelogUrlForVersion("1.2.3"));
	});

	it("dashes every dot, not just the first", () => {
		// A single-replace bug yields "#v10-4.2", which is a valid-looking fragment
		// that matches nothing on the page.
		expect(changelogUrlForVersion("10.4.2")).toBe("https://veyyon.dev/changelog#v10-4-2");
	});

	it("keeps prerelease and build metadata in the anchor", () => {
		// The generator slugs the version it was given; dropping the suffix here
		// would point a prerelease at the wrong entry rather than at none.
		expect(changelogUrlForVersion("1.2.3-rc.1")).toBe("https://veyyon.dev/changelog#v1-2-3-rc-1");
	});

	it("stays anchored to the one changelog URL constant", () => {
		// Re-hardcoding the origin here is how the picker and `/changelog` drift to
		// different hosts after a domain move.
		expect(changelogUrlForVersion("9.9.9").startsWith(`${CHANGELOG_URL}#`)).toBe(true);
	});
});
