/**
 * The release proof reads the page the generator actually writes.
 *
 * WHY THIS SUITE EXISTS. `assertPublishedChangelog` looked for `<h2 id="1.0.47">`
 * while `renderRelease` writes `<h2 id="v1-0-47">`, so the last step of a
 * release — the one that says the published version reached veyyon.dev — could
 * not pass on any release at all. It reported the correct, already-deployed
 * site as an unpropagated one, retried for two minutes, failed the release run,
 * and filed a release-train issue. The old suite agreed with the defect: it
 * hand-wrote its fixture in the checker's own spelling, so both halves could be
 * wrong together and stay green.
 *
 * THE CLASS THIS CLOSES. A fixture is no longer written by hand. Every case
 * runs the real `renderRelease` and asserts against ITS bytes, so the id format
 * has one owner and a change to it is either honoured by the checker or caught
 * here. The dotted spelling that shipped is asserted as a REJECT, so restating
 * the format in the checker fails rather than passing on a fixture that shares
 * the mistake.
 *
 * WHAT IT DOES NOT CATCH. Anything about the network: propagation delay, a CDN
 * serving a stale copy, or the redirect from `/changelog.html`. Those are the
 * fetch's business, and the release run exercises them for real.
 */

import { describe, expect, it } from "bun:test";

import { changelogUrlForVersion, CHANGELOG_URL as SITE_CHANGELOG_URL } from "@veyyon/utils";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { releaseAnchor, renderRelease } from "../website/tools/gen-changelog.mjs";
import { assertPublishedChangelog, publishedReleaseUrl } from "./verify-deployed-changelog";

/** Versions whose anchors differ in shape, so a per-character transform is exercised. */
const VERSIONS = ["1.2.3", "1.0.47", "10.0.0", "0.12.2"];

const repository = "santhreal/veyyon";

/** The page bytes the site build emits for one release card. */
function card(version: string, { published }: { published: boolean }): string {
	return renderRelease(
		{
			version,
			date: "2026-01-01",
			sections: [{ name: "Fixed", items: ["A fix that shipped in this version."] }],
			published,
			publishedDate: "2026-01-02",
			githubUrl: published ? publishedReleaseUrl(repository, `v${version}`) : "",
		},
		{ isLatest: true },
	);
}

describe("deployed changelog release proof", () => {
	/**
	 * Swept over versions whose anchors differ in shape (a two-digit component,
	 * a zero component), because the transform is per character and a checker
	 * that happened to agree on `1.2.3` could still disagree on `1.0.47`.
	 */
	it.each(VERSIONS)("accepts the generator's published card for %s", version => {
		expect(() =>
			assertPublishedChangelog(card(version, { published: true }), repository, `v${version}`),
		).not.toThrow();
	});

	/**
	 * The spelling that shipped. Matching it would mean the checker had restated
	 * the format again instead of asking the generator, which is the defect.
	 */
	it("rejects a card carrying the dotted id the checker used to look for", () => {
		const body = '<h2 id="1.2.3"><a href="#1.2.3">1.2.3</a></h2>';
		expect(() => assertPublishedChangelog(body, repository, "v1.2.3")).toThrow(
			"deployed changelog has no v1.2.3 release card",
		);
	});

	/**
	 * The THIRD restatement of the same format. `veyyon update` and the rollback
	 * picker print `…/changelog#v1-0-47` from `changelogUrlForVersion`, which
	 * cannot import the site generator (it ships in the CLI), so the only thing
	 * holding the two together is this assertion: a link the product prints must
	 * land on a card the page actually has.
	 */
	it.each(VERSIONS)("points the CLI's own changelog link at the generated card for %s", version => {
		const expected = `${SITE_CHANGELOG_URL}#${releaseAnchor(version)}`;
		expect(changelogUrlForVersion(version)).toBe(expected);
		expect(changelogUrlForVersion(`v${version}`)).toBe(expected);
		expect(card(version, { published: true })).toContain(`<h2 id="${releaseAnchor(version)}"`);
	});

	/** The id is the generator's, whatever it is: the two must agree by construction. */
	it("looks the card up by the id the generator writes", () => {
		expect(card("1.2.3", { published: true })).toContain(`<h2 id="${releaseAnchor("1.2.3")}"`);
	});

	/** A successful deployment of the pre-publication build must not masquerade as the final site. */
	it("rejects a release card that still has pending draft state", () => {
		const body = card("1.2.3", { published: false });
		expect(body).toContain("pending release");
		expect(() => assertPublishedChangelog(body, repository, "v1.2.3")).toThrow(
			"deployed changelog still marks v1.2.3 as pending",
		);
	});

	/** A stale site from before the version was cut must identify the missing release card directly. */
	it("rejects a page without the released version", () => {
		expect(() => assertPublishedChangelog(card("1.2.2", { published: true }), repository, "v1.2.3")).toThrow(
			"deployed changelog has no v1.2.3 release card",
		);
	});

	/** Invalid operator input must fail before any network or page-content decision can be made. */
	it("rejects malformed repository and tag identities", () => {
		expect(() => publishedReleaseUrl("one-component", "v1.2.3")).toThrow("invalid GitHub repository identity");
		expect(() => publishedReleaseUrl(repository, "latest")).toThrow("invalid release tag");
	});
});
