import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as parallel from "../../src/parallel";
import type { ScrapeServices } from "../../src/scrapers/types";
import { handleYouTube } from "../../src/scrapers/youtube";
import { asRender } from "../helpers/scrapers";

/**
 * WHY: the YouTube handler downloads one subtitle track through yt-dlp, the manual track when
 * yt-dlp lists one and the auto-generated track otherwise, and one download path serves both.
 * This suite drives the real handler against a stand-in yt-dlp that answers the same four
 * invocations (`--dump-json`, `--list-subs`, `--write-sub`, `--write-auto-sub`) from a fixture, so
 * it pins which track is requested, what the transcript section states about its source, and the
 * fallback when the listed manual track cannot be downloaded. It also pins the rendered metadata
 * header and description, the note for metadata that is not JSON, and every URL shape that names a
 * video. The Parallel extract path is pinned at its boundary: a configured reader whose answer
 * holds more than 100 characters renders the page, and a shorter answer or a failure falls back to
 * yt-dlp.
 *
 * It does not cover the yt-dlp download itself or the Parallel HTTP request.
 */

const FAKE_YTDLP = `#!/usr/bin/env bash
set -u
tracks=$(cat "$(dirname "$0")/tracks")
out=""
mode=""
while [ $# -gt 0 ]; do
	case "$1" in
		--dump-json) mode=meta ;;
		--list-subs) mode=list ;;
		--write-sub) mode=manual ;;
		--write-auto-sub) mode=auto ;;
		-o) shift; out=$1 ;;
	esac
	shift
done
has() { case " $tracks " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
case "$mode" in
	meta)
		if has bad-meta; then echo 'not json'; exit 0; fi
		if has uploader-meta; then
			desc=$(head -c 1500 /dev/zero | tr '\\0' d)
			printf '{"title":"Fixture video","uploader":"Fixture uploader","description":"%s"}\\n' "$desc"
			exit 0
		fi
		printf '%s\\n' '{"title":"Fixture video","channel":"Fixture channel","duration":61,' \\
			'"upload_date":"20240102","view_count":950,"description":"A fixture description."}'
		;;
	list)
		has list-manual && echo "[info] Available subtitles for fixture:"
		has list-auto && echo "[info] Available automatic captions for fixture:"
		;;
	manual)
		has write-manual || exit 1
		printf '%s\\n' WEBVTT '' '00:00:00.000 --> 00:00:01.000' 'Manual line one' '' \\
			'00:00:01.000 --> 00:00:02.000' 'Manual line two' > "$out.en.vtt"
		;;
	auto)
		has write-auto || exit 1
		printf '%s\\n' WEBVTT '' '00:00:00.000 --> 00:00:01.000' 'Auto line one' > "$out.en.vtt"
		;;
esac
`;

describe("a YouTube video renders its metadata and preferred transcript", () => {
	let toolDir: string;
	let services: ScrapeServices;

	beforeEach(async () => {
		toolDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-fake-ytdlp-"));
		const ytdlp = path.join(toolDir, "yt-dlp");
		await fs.writeFile(ytdlp, FAKE_YTDLP, { mode: 0o755 });
		services = {
			credentials: null,
			convertDocument: async () => ({ content: "", ok: false, error: "not used here" }),
			ensureTool: async () => ytdlp,
			spawnHook: () => undefined,
			fetchPreference: () => "native",
		};
	});

	afterEach(async () => {
		await fs.rm(toolDir, { recursive: true, force: true });
	});

	async function scrape(
		tracks: string,
		url = "https://youtu.be/dQw4w9WgXcQ",
	): Promise<{ content: string; notes: string[]; finalUrl: string }> {
		await fs.writeFile(path.join(toolDir, "tracks"), tracks);
		const result = asRender(await handleYouTube(url, 30, undefined, services));
		if (!result) throw new Error("expected a YouTube render");
		expect(result.method).toBe("youtube");
		return { content: result.content, notes: result.notes, finalUrl: result.finalUrl };
	}

	it("downloads the manual track when yt-dlp lists one and states it as the source", async () => {
		const { content, notes } = await scrape("list-manual write-manual list-auto write-auto");

		expect(content).toContain("# Fixture video\n\n**Channel:** Fixture channel\n**Uploaded:** 2024-01-02\n");
		expect(content).toContain("**Video ID:** dQw4w9WgXcQ");
		expect(content).toContain("## Transcript (manual)\n\nManual line one Manual line two");
		expect(notes).toContain("Using manual subtitles");
		expect(notes).not.toContain("Using auto-generated captions");
	});

	it("downloads the auto-generated track when no manual track is listed", async () => {
		const { content, notes } = await scrape("list-auto write-auto");

		expect(content).toContain("## Transcript (auto-generated)\n\nAuto line one");
		expect(notes).toContain("Using auto-generated captions");
		expect(notes).not.toContain("Using manual subtitles");
	});

	it("falls back to the auto-generated track when the listed manual track cannot be downloaded", async () => {
		const { content, notes } = await scrape("list-manual list-auto write-auto");

		expect(content).toContain("## Transcript (auto-generated)\n\nAuto line one");
		expect(content).not.toContain("Manual line");
		expect(notes).toContain("Using auto-generated captions");
		expect(notes).not.toContain("Using manual subtitles");
	});

	it("reports the missing transcript when neither track is listed", async () => {
		const { content, notes } = await scrape("");

		expect(content).toContain("*No transcript available for this video.*");
		expect(content).not.toContain("## Transcript");
		expect(notes).toContain("No subtitles/captions available");
	});

	it("renders the metadata header, the description and the transcript in that order", async () => {
		const { content } = await scrape("list-manual write-manual");

		expect(content).toBe(
			[
				"# Fixture video",
				"",
				"**Channel:** Fixture channel",
				"**Uploaded:** 2024-01-02",
				"**Duration:** 1:01",
				"**Views:** 950",
				"**Video ID:** dQw4w9WgXcQ",
				"",
				"---",
				"",
				"## Description",
				"",
				"A fixture description.",
				"",
				"---",
				"",
				"## Transcript (manual)",
				"",
				"Manual line one Manual line two",
			].join("\n"),
		);
	});

	it("keeps the fallback title and notes metadata yt-dlp did not answer as JSON", async () => {
		const { content, notes } = await scrape("bad-meta");

		expect(content).toBe(
			[
				"# YouTube Video",
				"",
				"**Video ID:** dQw4w9WgXcQ",
				"",
				"---",
				"",
				"*No transcript available for this video.*",
			].join("\n"),
		);
		expect(notes.some(note => note.startsWith("yt-dlp metadata was not valid JSON ("))).toBe(true);
	});

	it("names the uploader when there is no channel and truncates the description at 1000 characters", async () => {
		const { content } = await scrape("uploader-meta");

		expect(content).toContain("**Channel:** Fixture uploader\n");
		expect(content).toContain(`## Description\n\n${"d".repeat(999)}…\n\n---`);
	});

	it("renders a Parallel extract longer than 100 characters, and falls back to yt-dlp on a shorter one or a failure", async () => {
		const key = spyOn(parallel, "findParallelApiKey").mockReturnValue("parallel-test-key");
		const extract = spyOn(parallel, "extractWithParallel");
		const answer = (excerpt: string) => ({
			requestId: "req",
			results: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", excerpts: [excerpt] }],
			errors: [],
			warnings: [],
			usage: [],
		});
		const parallelServices = { ...services, fetchPreference: () => "parallel" as const };
		const youtu = "https://youtu.be/dQw4w9WgXcQ";
		await fs.writeFile(path.join(toolDir, "tracks"), "");

		try {
			extract.mockResolvedValueOnce(answer("p".repeat(101)));
			const long = asRender(await handleYouTube(youtu, 30, undefined, parallelServices));
			expect({ method: long?.method, content: long?.content, notes: long?.notes }).toEqual({
				method: "parallel",
				content: "p".repeat(101),
				notes: ["Used Parallel extract for YouTube"],
			});

			extract.mockResolvedValueOnce(answer("p".repeat(100)));
			expect(asRender(await handleYouTube(youtu, 30, undefined, parallelServices))?.method).toBe("youtube");

			extract.mockRejectedValueOnce(new Error("quota exhausted"));
			const failed = asRender(await handleYouTube(youtu, 30, undefined, parallelServices));
			expect(failed?.method).toBe("youtube");
			expect(failed?.notes).toContain("Parallel extract failed (quota exhausted); used yt-dlp instead");
		} finally {
			extract.mockRestore();
			key.mockRestore();
		}
	});

	it("reads the video ID from every URL shape that names one", async () => {
		for (const url of [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
			"https://m.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://youtube.com/embed/dQw4w9WgXcQ",
			"https://www.youtube.com/v/dQw4w9WgXcQ",
			"https://youtube.com/shorts/dQw4w9WgXcQ/",
			"https://youtu.be/dQw4w9WgXcQ?t=5",
		]) {
			const { content, finalUrl } = await scrape("", url);
			expect({ url, finalUrl }).toEqual({ url, finalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
			expect(content).toContain("**Video ID:** dQw4w9WgXcQ\n");
		}
	});

	it("does not match a URL that names no video", async () => {
		for (const url of [
			"https://www.youtube.com/watch",
			"https://www.youtube.com/channel/UC123",
			"https://youtube.com/shorts/short",
			"https://youtu.be/short",
			"https://example.com/watch?v=dQw4w9WgXcQ",
			"not a url",
		]) {
			expect({ url, result: await handleYouTube(url, 30, undefined, services) }).toEqual({ url, result: null });
		}
	});
});
