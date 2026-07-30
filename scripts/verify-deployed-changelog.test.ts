import { describe, expect, it } from "bun:test";
import { assertPublishedChangelog, publishedReleaseUrl } from "./verify-deployed-changelog";

const repository = "santhreal/veyyon";
const tag = "v1.2.3";
const heading = '<h2 id="1.2.3"><a href="#1.2.3">1.2.3</a></h2>';

describe("deployed changelog release proof", () => {
	/** The post-publication page is accepted only when its card links the immutable GitHub release. */
	it("accepts the published release card", () => {
		const body = `${heading}<a class="gh-link" href="${publishedReleaseUrl(repository, tag)}">View on GitHub</a>`;
		expect(() => assertPublishedChangelog(body, repository, tag)).not.toThrow();
	});

	/** A successful deployment of the pre-publication build must not masquerade as the final site. */
	it("rejects a release card that still has pending draft state", () => {
		const body = `${heading}<span class="pending">pending release</span>`;
		expect(() => assertPublishedChangelog(body, repository, tag)).toThrow(
			"deployed changelog still marks v1.2.3 as pending",
		);
	});

	/** A stale site from before the version was cut must identify the missing release card directly. */
	it("rejects a page without the released version", () => {
		expect(() => assertPublishedChangelog('<h2 id="1.2.2">1.2.2</h2>', repository, tag)).toThrow(
			"deployed changelog has no v1.2.3 release card",
		);
	});

	/** Invalid operator input must fail before any network or page-content decision can be made. */
	it("rejects malformed repository and tag identities", () => {
		expect(() => publishedReleaseUrl("one-component", tag)).toThrow("invalid GitHub repository identity");
		expect(() => publishedReleaseUrl(repository, "latest")).toThrow("invalid release tag");
	});
});
