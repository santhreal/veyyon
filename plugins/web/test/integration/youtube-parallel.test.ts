import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as parallelModule from "@veyyon/web/parallel";
import type { ScrapeServices } from "@veyyon/web/scrapers/types";
import { handleYouTube } from "@veyyon/web/scrapers/youtube";
import { asRender } from "../helpers/scrapers";

/**
 * WHY: the YouTube handler has two sources and a preference between them. Parallel extract returns
 * the page's own text, yt-dlp returns metadata and a subtitle track, and the second one downloads a
 * binary the first makes unnecessary. Both the preference and the external-tool resolver arrive
 * through `ScrapeServices`, so this suite is also what proves the injection: a handler that went
 * back to reading a global would stop honoring the preference passed here.
 *
 * It does not cover the yt-dlp path itself, which needs the binary.
 */

/** A services object that answers the two calls this handler makes, and records the second. */
function servicesWith(fetchPreference: string): { services: ScrapeServices; toolRequests: string[] } {
	const toolRequests: string[] = [];
	return {
		toolRequests,
		services: {
			credentials: null,
			convertDocument: async () => ({ content: "", ok: false, error: "not used here" }),
			async ensureTool(name) {
				toolRequests.push(name);
				return null;
			},
			spawnHook: () => undefined,
			fetchPreference: () => fetchPreference,
		},
	};
}

describe("handleYouTube with Parallel extract", () => {
	beforeEach(() => {
		process.env.PARALLEL_API_KEY = "test-parallel-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	it("returns Parallel extract content before yt-dlp fallback", async () => {
		const { services, toolRequests } = servicesWith("auto");
		vi.spyOn(parallelModule, "extractWithParallel").mockResolvedValue({
			requestId: "extract-youtube-1",
			results: [
				{
					url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
					title: "Video page",
					excerpts: [
						"Parallel summary for the video page that is comfortably longer than one hundred characters. ".repeat(
							2,
						),
					],
				},
			],
			errors: [],
			warnings: [],
			usage: [],
		});
		const result = asRender(await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10, undefined, services));
		expect(result?.method).toBe("parallel");
		expect(result?.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Parallel summary for the video page");
		expect(result?.notes).toContain("Used Parallel extract for YouTube");
		expect(toolRequests).toEqual([]);
	});

	it("skips Parallel entirely when the operator chose another reader", async () => {
		const { services, toolRequests } = servicesWith("native");
		const extract = vi.spyOn(parallelModule, "extractWithParallel");

		const result = asRender(await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10, undefined, services));

		expect(extract).not.toHaveBeenCalled();
		// The resolver answered null, so the handler reports the missing binary rather than
		// silently returning nothing.
		expect(toolRequests).toEqual(["yt-dlp"]);
		expect(result?.method).toBe("youtube-no-ytdlp");
	});

	it("reports the missing resolver when no host supplied one", async () => {
		const extract = vi.spyOn(parallelModule, "extractWithParallel");

		const result = asRender(await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10));

		expect(extract).not.toHaveBeenCalled();
		expect(result?.method).toBe("youtube-no-ytdlp");
		expect(result?.notes).toContain("no external-tool resolver was supplied");
	});
});
