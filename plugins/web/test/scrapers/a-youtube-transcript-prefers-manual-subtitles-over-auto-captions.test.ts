import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ScrapeServices } from "../../src/scrapers/types";
import { handleYouTube } from "../../src/scrapers/youtube";
import { asRender } from "../helpers/scrapers";

/**
 * WHY: the YouTube handler downloads one subtitle track through yt-dlp, the manual track when
 * yt-dlp lists one and the auto-generated track otherwise, and one download path serves both.
 * This suite drives the real handler against a stand-in yt-dlp that answers the same four
 * invocations (`--dump-json`, `--list-subs`, `--write-sub`, `--write-auto-sub`) from a fixture, so
 * it pins which track is requested, what the transcript section states about its source, and the
 * fallback when the listed manual track cannot be downloaded.
 *
 * It does not cover the yt-dlp download itself or the Parallel extract path.
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
		printf '%s\\n' '{"title":"Fixture video","channel":"Fixture channel","duration":61,' \\
			'"upload_date":"20240102","view_count":950}'
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

describe("a YouTube transcript prefers manual subtitles over auto captions", () => {
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

	async function scrape(tracks: string): Promise<{ content: string; notes: string[] }> {
		await fs.writeFile(path.join(toolDir, "tracks"), tracks);
		const result = asRender(await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30, undefined, services));
		if (!result) throw new Error("expected a YouTube render");
		expect(result.method).toBe("youtube");
		return { content: result.content, notes: result.notes };
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
});
