import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collapseWhitespace, errorMessage, ptree, Snowflake, truncate } from "@veyyon/utils";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { throwIfCancelled } from "../abort";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../parallel";
import type { RenderResult, ScrapeServices, SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, formatNumber, tryParseUrl } from "./types";

interface YouTubeUrl {
	videoId: string;
	playlistId?: string;
}

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Parse YouTube URL into components
 */
function parseYouTubeUrl(url: string): YouTubeUrl | null {
	const parsed = tryParseUrl(url);
	if (!parsed) return null;
	const hostname = parsed.hostname.replace(/^www\./, "");

	// youtu.be/VIDEO_ID
	if (hostname === "youtu.be") return leadingVideoId(parsed.pathname.slice(1));
	if (hostname !== "youtube.com" && hostname !== "m.youtube.com") return null;

	// youtube.com/watch?v=VIDEO_ID
	const watchId = parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
	if (watchId) return { videoId: watchId, playlistId: parsed.searchParams.get("list") || undefined };

	// youtube.com/v/VIDEO_ID or youtube.com/embed/VIDEO_ID
	const embedded = /^\/(v|embed)\/([a-zA-Z0-9_-]{11})/.exec(parsed.pathname);
	if (embedded) return { videoId: embedded[2] };

	// youtube.com/shorts/VIDEO_ID
	if (hostname === "youtube.com" && parsed.pathname.startsWith("/shorts/")) {
		return leadingVideoId(parsed.pathname.slice("/shorts/".length));
	}
	return null;
}

/** The video named by the first segment of `segments` when that segment is a video ID. */
function leadingVideoId(segments: string): YouTubeUrl | null {
	const videoId = segments.split("/")[0];
	return VIDEO_ID_RE.test(videoId) ? { videoId } : null;
}

/**
 * Clean VTT subtitle content to plain text
 */
function cleanVttToText(vtt: string): string {
	const lines = vtt.split("\n");
	const textLines: string[] = [];
	let lastLine = "";

	for (const line of lines) {
		// Skip WEBVTT header, timestamps, and metadata
		if (
			line.startsWith("WEBVTT") ||
			line.startsWith("Kind:") ||
			line.startsWith("Language:") ||
			line.match(/^\d{2}:\d{2}/) || // Timestamp lines
			line.match(/^[a-f0-9-]{36}$/) || // UUID cue identifiers
			line.match(/^\d+$/) || // Numeric cue identifiers
			line.includes("-->") ||
			line.trim() === ""
		) {
			continue;
		}

		// Remove inline timestamp tags like <00:00:01.520>
		let cleaned = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "");
		// Remove other VTT tags like <c> </c>
		cleaned = cleaned.replace(/<\/?[^>]+>/g, "");
		cleaned = cleaned.trim();

		// Skip duplicates (auto-generated captions often repeat)
		if (cleaned && cleaned !== lastLine) {
			textLines.push(cleaned);
			lastLine = cleaned;
		}
	}

	return collapseWhitespace(textLines.join(" "));
}

/**
 * Download one subtitle track for `videoUrl` beside `tmpBase` and return its cleaned text, or
 * undefined when yt-dlp failed or wrote no track. `trackFlag` selects the manual or the
 * auto-generated track.
 */
async function downloadSubtitleText(
	ytdlp: string,
	trackFlag: "--write-sub" | "--write-auto-sub",
	tmpBase: string,
	videoUrl: string,
	execOptions: ptree.ExecOptions,
): Promise<string | undefined> {
	const subResult = await ptree.exec(
		[
			ytdlp,
			trackFlag,
			"--sub-lang",
			"en,en-US,en-GB",
			"--sub-format",
			"vtt",
			"--skip-download",
			"--no-warnings",
			"--no-playlist",
			"-o",
			tmpBase,
			videoUrl,
		],
		execOptions,
	);
	if (!subResult.ok) return undefined;
	// Find the downloaded subtitle file using glob
	const subFiles = await Array.fromAsync(new Bun.Glob(`${tmpBase}*.vtt`).scan({ absolute: true }));
	if (subFiles.length === 0) return undefined;
	return cleanVttToText(await Bun.file(subFiles[0]).text());
}

/** Subtitle tracks in order of preference: the first one yt-dlp lists and can download is used. */
const SUBTITLE_TRACKS = [
	{
		listed: "[info] Available subtitles",
		flag: "--write-sub",
		source: "manual",
		note: "Using manual subtitles",
	},
	{
		listed: "[info] Available automatic captions",
		flag: "--write-auto-sub",
		source: "auto-generated",
		note: "Using auto-generated captions",
	},
] as const;

/** The fields of yt-dlp's `--dump-json` record the page renders. */
interface YtDlpMeta {
	title?: string;
	channel?: string;
	uploader?: string;
	description?: string;
	duration?: number;
	upload_date?: string;
	view_count?: number;
}

/** Video metadata with every absent field at its empty value; `uploaded` is `YYYY-MM-DD` or empty. */
interface VideoMeta {
	title: string;
	channel: string;
	description: string;
	duration: number;
	uploaded: string;
	viewCount: number;
}

interface Transcript {
	text: string;
	source: string;
}

/**
 * Handle YouTube URLs - fetch metadata and transcript
 */
export const handleYouTube: SpecialHandler = async (
	url: string,
	timeout: number,
	userSignal?: AbortSignal,
	services?: ScrapeServices,
): Promise<RenderResult | null> => {
	throwIfCancelled(userSignal);
	const yt = parseYouTubeUrl(url);
	if (!yt) return null;

	// Scoped so the deadline timer is cleared on settle instead of staying
	// armed like a bare AbortSignal.timeout; the fence spans every fetch and
	// yt-dlp invocation in the handler.
	const handlerTimeout = scopedTimeoutSignal(timeout * 1000, userSignal);
	const signal = handlerTimeout.signal;
	try {
		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];
		const videoUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;

		const extracted = await extractViaParallel(url, videoUrl, fetchedAt, notes, signal, services);
		if (extracted) return extracted;

		// Ensure yt-dlp is available (auto-download if missing)
		const ytdlp = services ? await services.ensureTool("yt-dlp", { signal, silent: true }) : null;
		if (!ytdlp) {
			const cause = services ? "yt-dlp could not be installed" : "no external-tool resolver was supplied";
			return {
				url,
				finalUrl: url,
				contentType: "text/plain",
				method: "youtube-no-ytdlp",
				content: `YouTube video detected but ${cause}.`,
				fetchedAt: new Date().toISOString(),
				truncated: false,
				notes: [cause],
			};
		}

		const execOptions: ptree.ExecOptions = {
			signal,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
			onSpawnPid: services?.spawnHook(),
		};
		const meta = await readVideoMeta(ytdlp, videoUrl, execOptions, notes);
		const transcript = await readTranscript(ytdlp, yt.videoId, videoUrl, execOptions, notes);

		// Only a user-initiated abort is fatal; the per-fetch time budget expiring
		// just means partial metadata/transcript, which we surface as a note.
		throwIfCancelled(userSignal);
		if (signal?.aborted) {
			notes.push("Fetch time budget exhausted; metadata/transcript may be incomplete");
		}

		const md = renderVideo(meta, yt.videoId, transcript, notes);
		return buildResult(md, { url, finalUrl: videoUrl, method: "youtube", fetchedAt, notes });
	} finally {
		handlerTimeout.cancel();
	}
};

/**
 * The video page through Parallel extract, when Parallel sits in the reader
 * chain, its key is configured and it answers with real content; otherwise
 * `null`, and yt-dlp renders the page.
 */
async function extractViaParallel(
	url: string,
	videoUrl: string,
	fetchedAt: string,
	notes: string[],
	signal: AbortSignal,
	services: ScrapeServices | undefined,
): Promise<RenderResult | null> {
	const fetchPreference = services?.fetchPreference();
	const storage = services?.credentials;
	if ((fetchPreference !== "auto" && fetchPreference !== "parallel") || !findParallelApiKey(storage)) return null;
	try {
		const parallelResult = await extractWithParallel(
			[videoUrl],
			{
				objective: "Extract the main content of this YouTube video page",
				excerpts: true,
				fullContent: false,
				signal,
			},
			storage,
		);
		const firstDocument = parallelResult.results[0];
		const content = firstDocument ? getParallelExtractContent(firstDocument) : "";
		if (content.trim().length <= 100) return null;
		return buildResult(content, {
			url,
			finalUrl: videoUrl,
			method: "parallel",
			fetchedAt,
			notes: ["Used Parallel extract for YouTube"],
		});
	} catch (error) {
		throwIfCancelled(signal);
		// Parallel extract is the better source when it works (a real transcript rather
		// than yt-dlp metadata), so its failure changes what the reader gets. yt-dlp
		// still runs, which is why this is a note and not a degrade.
		notes.push(`Parallel extract failed (${errorMessage(error)}); used yt-dlp instead`);
		return null;
	}
}

async function readVideoMeta(
	ytdlp: string,
	videoUrl: string,
	execOptions: ptree.ExecOptions,
	notes: string[],
): Promise<VideoMeta> {
	const result = await ptree.exec(
		[ytdlp, "--dump-json", "--no-warnings", "--no-playlist", "--skip-download", videoUrl],
		execOptions,
	);
	if (result.ok && result.stdout.trim()) {
		try {
			return videoMeta(JSON.parse(result.stdout) as YtDlpMeta);
		} catch (error) {
			// yt-dlp answered with something that is not the JSON it documents. The result
			// is still built, from the fallback title alone, so the reader has to be
			// told the metadata is missing rather than absent from the video.
			notes.push(`yt-dlp metadata was not valid JSON (${errorMessage(error)}); title and channel are unavailable`);
		}
	}
	return videoMeta({});
}

function videoMeta(meta: YtDlpMeta): VideoMeta {
	const uploadDate = meta.upload_date || "";
	return {
		title: meta.title || "YouTube Video",
		channel: meta.channel || meta.uploader || "",
		description: meta.description || "",
		duration: meta.duration || 0,
		uploaded:
			uploadDate.length === 8 ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}` : "",
		viewCount: meta.view_count || 0,
	};
}

/**
 * The text of the first track in {@link SUBTITLE_TRACKS} that yt-dlp lists and
 * downloads with content, or an empty transcript. The downloaded files are
 * removed afterwards.
 */
async function readTranscript(
	ytdlp: string,
	videoId: string,
	videoUrl: string,
	execOptions: ptree.ExecOptions,
	notes: string[],
): Promise<Transcript> {
	const listResult = await ptree.exec(
		[ytdlp, "--list-subs", "--no-warnings", "--no-playlist", "--skip-download", videoUrl],
		execOptions,
	);
	const tmpBase = path.join(os.tmpdir(), `yt-${videoId}-${Snowflake.next()}`);
	try {
		let transcript: Transcript = { text: "", source: "" };
		for (const track of SUBTITLE_TRACKS) {
			if (transcript.text || !listResult.stdout.includes(track.listed)) continue;
			const text = await downloadSubtitleText(ytdlp, track.flag, tmpBase, videoUrl, execOptions);
			if (text === undefined) continue;
			transcript = { text, source: track.source };
			notes.push(track.note);
		}
		return transcript;
	} finally {
		// Cleanup temp files (fire-and-forget with error suppression)
		Array.fromAsync(new Bun.Glob(`${tmpBase}*`).scan({ absolute: true }))
			.then(tmpFiles => Promise.all(tmpFiles.map(f => fs.unlink(f).catch(() => {}))))
			.catch(() => {});
	}
}

/** The page markdown; a video with no transcript adds a note saying so. */
function renderVideo(meta: VideoMeta, videoId: string, transcript: Transcript, notes: string[]): string {
	let md = `# ${meta.title}\n\n`;
	if (meta.channel) md += `**Channel:** ${meta.channel}\n`;
	if (meta.uploaded) md += `**Uploaded:** ${meta.uploaded}\n`;
	if (meta.duration > 0) md += `**Duration:** ${formatMediaDuration(meta.duration)}\n`;
	if (meta.viewCount > 0) md += `**Views:** ${formatNumber(meta.viewCount)}\n`;
	md += `**Video ID:** ${videoId}\n\n`;

	if (meta.description) {
		md += `---\n\n## Description\n\n${truncate(meta.description, 1000)}\n\n`;
	}

	if (transcript.text) {
		return `${md}---\n\n## Transcript (${transcript.source})\n\n${transcript.text}\n`;
	}
	notes.push("No subtitles/captions available");
	return `${md}---\n\n*No transcript available for this video.*\n`;
}
