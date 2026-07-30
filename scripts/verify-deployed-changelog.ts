#!/usr/bin/env bun
/**
 * Prove that the deployed changelog recognizes the release GitHub just
 * published. The pre-publication deployment intentionally renders the draft as
 * pending, so publication is complete only after a second build replaces that
 * card with its immutable GitHub release link.
 */

export const CHANGELOG_URL = "https://veyyon.dev/changelog.html";
export const PROPAGATION_ATTEMPTS = 12;
export const PROPAGATION_DELAY_MS = 10_000;

export function publishedReleaseUrl(repository: string, tag: string): string {
	if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
		throw new Error(`invalid GitHub repository identity: ${repository}`);
	}
	if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
		throw new Error(`invalid release tag: ${tag}`);
	}
	return `https://github.com/${repository}/releases/tag/${tag}`;
}

/**
 * Reject a stale pre-publication page. A pending card has the release heading,
 * but only a published card carries the immutable GitHub release link.
 */
export function assertPublishedChangelog(body: string, repository: string, tag: string): void {
	const version = tag.slice(1);
	const heading = `<h2 id="${version}">`;
	if (!body.includes(heading)) {
		throw new Error(`deployed changelog has no ${tag} release card`);
	}
	const releaseUrl = publishedReleaseUrl(repository, tag);
	if (!body.includes(`href="${releaseUrl}"`)) {
		throw new Error(`deployed changelog still marks ${tag} as pending; missing ${releaseUrl}`);
	}
}

async function fetchChangelog(attempt: number): Promise<string> {
	const url = new URL(CHANGELOG_URL);
	url.searchParams.set("release-proof", `${Date.now()}-${attempt}`);
	const response = await fetch(url, {
		cache: "no-store",
		headers: { "cache-control": "no-cache" },
	});
	if (!response.ok) throw new Error(`${CHANGELOG_URL} returned HTTP ${response.status}`);
	return response.text();
}

async function main(): Promise<void> {
	const tag = process.argv[2];
	const repository = Bun.env.GITHUB_REPOSITORY;
	if (!tag) throw new Error("usage: bun scripts/verify-deployed-changelog.ts <vX.Y.Z>");
	if (!repository) throw new Error("GITHUB_REPOSITORY is required (owner/repository)");

	let lastFailure = "deployment was not checked";
	for (let attempt = 1; attempt <= PROPAGATION_ATTEMPTS; attempt++) {
		try {
			assertPublishedChangelog(await fetchChangelog(attempt), repository, tag);
			console.log(`OK  ${CHANGELOG_URL} links the published ${tag} release`);
			return;
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
			if (attempt < PROPAGATION_ATTEMPTS) await Bun.sleep(PROPAGATION_DELAY_MS);
		}
	}
	throw new Error(
		`${CHANGELOG_URL} did not expose published ${tag} after ${PROPAGATION_ATTEMPTS} propagation checks: ${lastFailure}`,
	);
}

if (import.meta.main) await main();
