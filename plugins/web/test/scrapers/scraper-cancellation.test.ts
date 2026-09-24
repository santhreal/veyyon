import { describe, expect, it } from "bun:test";
import { isCancellation } from "@veyyon/utils/abortable";
import { fetchGitHubApi } from "@veyyon/web/scrapers/github";
import { handleMastodon } from "@veyyon/web/scrapers/mastodon";

describe("scraper cancellation propagation", () => {
	it("fetchGitHubApi throws on caller cancellation rather than swallowing it", async () => {
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));

		let threwCancellation = false;
		try {
			await fetchGitHubApi("/repos/owner/repo", 5, controller.signal);
		} catch (error) {
			threwCancellation = isCancellation(error);
		}
		expect(threwCancellation).toBe(true);
	});

	it("handleMastodon throws on caller cancellation during instance probe", async () => {
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));

		let threwCancellation = false;
		try {
			await handleMastodon("https://mastodon.social/@username", 5, controller.signal);
		} catch (error) {
			threwCancellation = isCancellation(error);
		}
		expect(threwCancellation).toBe(true);
	});
});
