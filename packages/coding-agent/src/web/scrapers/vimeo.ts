import { tryParseJson } from "@veyyon/utils";
import { markdownLink } from "../../utils/markdown-link";
import type { SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "./types";

interface VimeoOEmbed {
	title: string;
	author_name: string;
	author_url: string;
	description?: string;
	duration: number;
	thumbnail_url: string;
	upload_date: string;
	video_id: number;
}

interface VimeoVideoConfig {
	video?: {
		title?: string;
		duration?: number;
		owner?: {
			name?: string;
			url?: string;
		};
		thumbs?: {
			base?: string;
		};
	};
	request?: {
		files?: {
			progressive?: Array<{
				quality: string;
				width: number;
				height: number;
				fps: number;
			}>;
		};
	};
}

function extractVideoId(url: string): string | null {
	const parsed = tryParseUrl(url);
	if (!parsed) return null;

	if (parsed.hostname === "player.vimeo.com") {
		const match = parsed.pathname.match(/^\/video\/(\d+)/);
		return match?.[1] ?? null;
	}

	if (parsed.hostname === "vimeo.com" || parsed.hostname === "www.vimeo.com") {
		const parts = parsed.pathname.split("/").filter(Boolean);
		const lastPart = parts[parts.length - 1];
		if (lastPart && /^\d+$/.test(lastPart)) {
			return lastPart;
		}
	}

	return null;
}

export const handleVimeo: SpecialHandler = async (url: string, timeout: number, signal?: AbortSignal) => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		if (!parsed.hostname.includes("vimeo.com")) return null;

		const videoId = extractVideoId(url);
		if (!videoId) return null;

		const fetchedAt = new Date().toISOString();

		const canonicalUrl = `https://vimeo.com/${videoId}`;
		const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonicalUrl)}`;
		const oembedResult = await loadPage(oembedUrl, { timeout, signal });

		if (!oembedResult.ok) return scraperDegrade("vimeo", loadFailure(oembedResult));

		const oembed = tryParseJson<VimeoOEmbed>(oembedResult.content);
		if (!oembed) return scraperDegrade("vimeo", "unexpected response shape");

		let md = `# ${oembed.title}\n\n`;
		md += `**Author:** ${markdownLink(oembed.author_name, oembed.author_url)}\n`;
		md += `**Duration:** ${formatMediaDuration(oembed.duration)}\n`;

		if (oembed.upload_date) {
			md += `**Uploaded:** ${oembed.upload_date}\n`;
		}

		md += `**Video ID:** ${videoId}\n\n`;

		if (oembed.description) {
			md += `---\n\n## Description\n\n${oembed.description}\n\n`;
		}

		md += `---\n\n**Thumbnail:** ${oembed.thumbnail_url}\n`;

		try {
			const configUrl = `https://player.vimeo.com/video/${videoId}/config`;
			const configResult = await loadPage(configUrl, { timeout: Math.min(timeout, 5), signal });

			if (configResult.ok) {
				const config = tryParseJson<VimeoVideoConfig>(configResult.content);

				const progressive = config?.request?.files?.progressive;
				if (progressive && progressive.length > 0) {
					md += `\n**Available Qualities:**\n`;
					for (const quality of progressive.slice(0, 5)) {
						md += `- ${quality.quality}: ${quality.width}x${quality.height} @ ${quality.fps}fps\n`;
					}
				}
			}
		} catch {}

		return buildResult(md, { url, method: "vimeo", fetchedAt, notes: ["Fetched via Vimeo oEmbed API"] });
	} catch (error) {
		return scraperDegrade("vimeo", error);
	}
};
