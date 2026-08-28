import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collapseWhitespace, errorMessage, ptree, Snowflake, truncate } from "@veyyon/utils";
import { settings } from "../../config/settings-instance";
import type { AgentStorage } from "../../session/agent-storage";
import { primarySessionCpuAdoption } from "../../session/cpu-limit";
import { throwIfAborted } from "../../tools/tool-errors";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { ensureTool } from "../../utils/tools-manager";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../parallel";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, formatNumber, tryParseUrl } from "./types";

interface YouTubeUrl {
	videoId: string;
	playlistId?: string;
}

function parseYouTubeUrl(url: string): YouTubeUrl | null {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		const hostname = parsed.hostname.replace(/^www\./, "");

		if ((hostname === "youtube.com" || hostname === "m.youtube.com") && parsed.pathname === "/watch") {
			const videoId = parsed.searchParams.get("v");
			const playlistId = parsed.searchParams.get("list") || undefined;
			if (videoId) return { videoId, playlistId };
		}

		if (hostname === "youtube.com" || hostname === "m.youtube.com") {
			const match = parsed.pathname.match(/^\/(v|embed)\/([a-zA-Z0-9_-]{11})/);
			if (match) return { videoId: match[2] };
		}

		if (hostname === "youtu.be") {
			const videoId = parsed.pathname.slice(1).split("/")[0];
			if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
				return { videoId };
			}
		}

		if (hostname === "youtube.com" && parsed.pathname.startsWith("/shorts/")) {
			const videoId = parsed.pathname.replace("/shorts/", "").split("/")[0];
			if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
				return { videoId };
			}
		}
	} catch {}

	return null;
}

function cleanVttToText(vtt: string): string {
	const lines = vtt.split("\n");
	const textLines: string[] = [];
	let lastLine = "";

	for (const line of lines) {
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

		let cleaned = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "");
		cleaned = cleaned.replace(/<\/?[^>]+>/g, "");
		cleaned = cleaned.trim();

		if (cleaned && cleaned !== lastLine) {
			textLines.push(cleaned);
			lastLine = cleaned;
		}
	}

	return collapseWhitespace(textLines.join(" "));
}

export const handleYouTube: SpecialHandler = async (
	url: string,
	timeout: number,
	userSignal?: AbortSignal,
	storage?: AgentStorage | null,
): Promise<RenderResult | null> => {
	throwIfAborted(userSignal);
	const yt = parseYouTubeUrl(url);
	if (!yt) return null;

	const handlerTimeout = scopedTimeoutSignal(timeout * 1000, userSignal);
	const signal = handlerTimeout.signal;
	try {
		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];
		const videoUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;

		const fetchPreference = settings.get("providers.fetch");
		if ((fetchPreference === "auto" || fetchPreference === "parallel") && findParallelApiKey(storage)) {
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
				if (firstDocument) {
					const content = getParallelExtractContent(firstDocument);
					if (content.trim().length > 100) {
						return buildResult(content, {
							url,
							finalUrl: videoUrl,
							method: "parallel",
							fetchedAt,
							notes: ["Used Parallel extract for YouTube"],
						});
					}
				}
			} catch (error) {
				throwIfAborted(signal);
				notes.push(`Parallel extract failed (${errorMessage(error)}); used yt-dlp instead`);
			}
		}

		const ytdlp = await ensureTool("yt-dlp", { signal, silent: true });
		if (!ytdlp) {
			return {
				url,
				finalUrl: url,
				contentType: "text/plain",
				method: "youtube-no-ytdlp",
				content: "YouTube video detected but yt-dlp could not be installed.",
				fetchedAt: new Date().toISOString(),
				truncated: false,
				notes: ["yt-dlp installation failed"],
			};
		}

		const execOptions = {
			mode: "group" as const,
			signal,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full" as const,
			onSpawnPid: primarySessionCpuAdoption(),
		};

		const metaResult = await ptree.exec(
			[ytdlp, "--dump-json", "--no-warnings", "--no-playlist", "--skip-download", videoUrl],
			execOptions,
		);

		let title = "YouTube Video";
		let channel = "";
		let description = "";
		let duration = 0;
		let uploadDate = "";
		let viewCount = 0;

		if (metaResult.ok && metaResult.stdout.trim()) {
			try {
				const meta = JSON.parse(metaResult.stdout) as {
					title?: string;
					channel?: string;
					uploader?: string;
					description?: string;
					duration?: number;
					upload_date?: string;
					view_count?: number;
				};
				title = meta.title || title;
				channel = meta.channel || meta.uploader || "";
				description = meta.description || "";
				duration = meta.duration || 0;
				uploadDate = meta.upload_date || "";
				viewCount = meta.view_count || 0;
			} catch (error) {
				notes.push(
					`yt-dlp metadata was not valid JSON (${errorMessage(error)}); title and channel are unavailable`,
				);
			}
		}

		let formattedDate = "";
		if (uploadDate && uploadDate.length === 8) {
			formattedDate = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
		}

		let transcript = "";
		let transcriptSource = "";

		const listResult = await ptree.exec(
			[ytdlp, "--list-subs", "--no-warnings", "--no-playlist", "--skip-download", videoUrl],
			execOptions,
		);

		const hasManualSubs = listResult.stdout.includes("[info] Available subtitles");
		const hasAutoSubs = listResult.stdout.includes("[info] Available automatic captions");

		const tmpDir = os.tmpdir();
		const tmpBase = path.join(tmpDir, `yt-${yt.videoId}-${Snowflake.next()}`);

		try {
			if (hasManualSubs) {
				const subResult = await ptree.exec(
					[
						ytdlp,
						"--write-sub",
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

				if (subResult.ok) {
					const subFiles = await Array.fromAsync(new Bun.Glob(`${tmpBase}*.vtt`).scan({ absolute: true }));
					if (subFiles.length > 0) {
						const vttContent = await Bun.file(subFiles[0]).text();
						transcript = cleanVttToText(vttContent);
						transcriptSource = "manual";
						notes.push("Using manual subtitles");
					}
				}
			}

			if (!transcript && hasAutoSubs) {
				const autoResult = await ptree.exec(
					[
						ytdlp,
						"--write-auto-sub",
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

				if (autoResult.ok) {
					const subFiles = await Array.fromAsync(new Bun.Glob(`${tmpBase}*.vtt`).scan({ absolute: true }));
					if (subFiles.length > 0) {
						const vttContent = await Bun.file(subFiles[0]).text();
						transcript = cleanVttToText(vttContent);
						transcriptSource = "auto-generated";
						notes.push("Using auto-generated captions");
					}
				}
			}
		} finally {
			Array.fromAsync(new Bun.Glob(`${tmpBase}*`).scan({ absolute: true }))
				.then(tmpFiles => Promise.all(tmpFiles.map(f => fs.unlink(f).catch(() => {}))))
				.catch(() => {});
		}
		throwIfAborted(userSignal);
		if (signal?.aborted) {
			notes.push("Fetch time budget exhausted; metadata/transcript may be incomplete");
		}

		let md = `# ${title}\n\n`;
		if (channel) md += `**Channel:** ${channel}\n`;
		if (formattedDate) md += `**Uploaded:** ${formattedDate}\n`;
		if (duration > 0) md += `**Duration:** ${formatMediaDuration(duration)}\n`;
		if (viewCount > 0) md += `**Views:** ${formatNumber(viewCount)}\n`;
		md += `**Video ID:** ${yt.videoId}\n\n`;

		if (description) {
			const descPreview = truncate(description, 1000);
			md += `---\n\n## Description\n\n${descPreview}\n\n`;
		}

		if (transcript) {
			md += `---\n\n## Transcript (${transcriptSource})\n\n${transcript}\n`;
		} else {
			notes.push("No subtitles/captions available");
			md += `---\n\n*No transcript available for this video.*\n`;
		}

		return buildResult(md, { url, finalUrl: videoUrl, method: "youtube", fetchedAt, notes });
	} finally {
		handlerTimeout.cancel();
	}
};
