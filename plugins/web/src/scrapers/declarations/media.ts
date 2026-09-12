import { errorMessage, isCancellation } from "@veyyon/utils";
import { markdownLink } from "../../markdown-link";
import { loadJson } from "../engine/declarative";
import type { MediaDeclaration } from "../engine/media";
import { buildResult, formatMediaDuration, htmlToBasicMarkdown, isScraperDegrade } from "../types";

// --- Discogs ---

interface DiscogsArtist {
	name: string;
	anv?: string;
	role?: string;
	join?: string;
}

interface DiscogsTrack {
	position?: string;
	title: string;
	duration?: string;
	artists?: DiscogsArtist[];
	extraartists?: DiscogsArtist[];
}

interface DiscogsLabel {
	name: string;
	catno?: string;
}

interface DiscogsFormat {
	name: string;
	qty?: string;
	descriptions?: string[];
}

interface DiscogsRelease {
	id: number;
	title: string;
	artists?: DiscogsArtist[];
	year?: number;
	released?: string;
	country?: string;
	genres?: string[];
	styles?: string[];
	labels?: DiscogsLabel[];
	formats?: DiscogsFormat[];
	tracklist?: DiscogsTrack[];
	extraartists?: DiscogsArtist[];
	notes?: string;
	uri?: string;
	master_id?: number;
	master_url?: string;
}

interface DiscogsMaster {
	id: number;
	title: string;
	artists?: DiscogsArtist[];
	year?: number;
	genres?: string[];
	styles?: string[];
	tracklist?: DiscogsTrack[];
	notes?: string;
	uri?: string;
	main_release?: number;
	main_release_url?: string;
	versions_url?: string;
	num_for_sale?: number;
	lowest_price?: number;
}

function formatDiscogsArtists(artists: DiscogsArtist[] | undefined): string {
	if (!artists?.length) return "Unknown Artist";
	return artists
		.map(a => {
			const name = a.anv || a.name;
			const join = a.join || ", ";
			return name + (a.join ? ` ${join} ` : "");
		})
		.join("")
		.replace(/[,&]\s*$/, "")
		.trim();
}

function formatDiscogsTrack(track: DiscogsTrack): string {
	let line = track.position ? `${track.position}. ` : "- ";
	line += track.title;
	if (track.duration) line += ` (${track.duration})`;
	if (track.artists?.length) {
		line += ` - ${formatDiscogsArtists(track.artists)}`;
	}
	return line;
}

function formatDiscogsCredits(extraartists: DiscogsArtist[] | undefined): string {
	if (!extraartists?.length) return "";

	const byRole: Record<string, string[]> = {};
	for (const artist of extraartists) {
		const role = artist.role || "Other";
		if (!byRole[role]) byRole[role] = [];
		byRole[role].push(artist.anv || artist.name);
	}

	const lines: string[] = [];
	for (const [role, names] of Object.entries(byRole)) {
		lines.push(`- **${role}**: ${names.join(", ")}`);
	}
	return lines.join("\n");
}

function formatDiscogsFormats(formats: DiscogsFormat[] | undefined): string {
	if (!formats?.length) return "";

	return formats
		.map(f => {
			const parts: string[] = [];
			if (f.qty && Number.parseInt(f.qty, 10) > 1) parts.push(`${f.qty}×`);
			parts.push(f.name);
			if (f.descriptions?.length) parts.push(f.descriptions.join(", "));
			return parts.join(" ");
		})
		.join(" + ");
}

function formatDiscogsLabels(labels: DiscogsLabel[] | undefined): string {
	if (!labels?.length) return "";
	return labels
		.map(l => {
			if (l.catno && l.catno !== "none") return `${l.name} (${l.catno})`;
			return l.name;
		})
		.join(", ");
}

function buildDiscogsReleaseMarkdown(release: DiscogsRelease): string {
	const sections: string[] = [];

	const artist = formatDiscogsArtists(release.artists);
	sections.push(`# ${artist} - ${release.title}\n`);

	const meta: string[] = [];
	if (release.year) meta.push(`**Year**: ${release.year}`);
	if (release.country) meta.push(`**Country**: ${release.country}`);

	const format = formatDiscogsFormats(release.formats);
	if (format) meta.push(`**Format**: ${format}`);

	const labels = formatDiscogsLabels(release.labels);
	if (labels) meta.push(`**Label**: ${labels}`);

	if (release.genres?.length) meta.push(`**Genre**: ${release.genres.join(", ")}`);
	if (release.styles?.length) meta.push(`**Style**: ${release.styles.join(", ")}`);

	if (release.master_id) {
		meta.push(`**Master Release**: [${release.master_id}](https://www.discogs.com/master/${release.master_id})`);
	}

	if (meta.length) sections.push(`${meta.join("\n")}\n`);

	if (release.tracklist?.length) {
		sections.push("## Tracklist\n");
		const tracks = release.tracklist.map(formatDiscogsTrack);
		sections.push(`${tracks.join("\n")}\n`);
	}

	const credits = formatDiscogsCredits(release.extraartists);
	if (credits) {
		sections.push("## Credits\n");
		sections.push(`${credits}\n`);
	}

	if (release.notes) {
		sections.push("## Notes\n");
		sections.push(`${release.notes}\n`);
	}

	return sections.join("\n");
}

function buildDiscogsMasterMarkdown(master: DiscogsMaster): string {
	const sections: string[] = [];

	const artist = formatDiscogsArtists(master.artists);
	sections.push(`# ${artist} - ${master.title}\n`);
	sections.push("*Master Release*\n");

	const meta: string[] = [];
	if (master.year) meta.push(`**Year**: ${master.year}`);
	if (master.genres?.length) meta.push(`**Genre**: ${master.genres.join(", ")}`);
	if (master.styles?.length) meta.push(`**Style**: ${master.styles.join(", ")}`);

	if (master.main_release) {
		meta.push(`**Main Release**: [${master.main_release}](https://www.discogs.com/release/${master.main_release})`);
	}

	if (master.num_for_sale !== undefined && master.num_for_sale > 0) {
		meta.push(`**For Sale**: ${master.num_for_sale} copies`);
		if (master.lowest_price !== undefined) {
			meta.push(`**Lowest Price**: $${master.lowest_price.toFixed(2)}`);
		}
	}

	if (meta.length) sections.push(`${meta.join("\n")}\n`);

	if (master.tracklist?.length) {
		sections.push("## Tracklist\n");
		const tracks = master.tracklist.map(formatDiscogsTrack);
		sections.push(`${tracks.join("\n")}\n`);
	}

	if (master.notes) {
		sections.push("## Notes\n");
		sections.push(`${master.notes}\n`);
	}

	return sections.join("\n");
}

export const discogsDeclaration: MediaDeclaration = {
	site: "discogs",
	method: "discogs",
	hosts: ["discogs.com", "www.discogs.com"],
	canonicalUrls: [
		"https://www.discogs.com/release/249504-Daft-Punk-Discovery",
		"https://www.discogs.com/master/249504-Daft-Punk-Discovery",
	],
	match: parsed => {
		const relMatch = parsed.pathname.match(/\/release\/(\d+)/);
		const masMatch = parsed.pathname.match(/\/master\/(\d+)/);
		if (relMatch) return { id: relMatch[1], kind: "release", parsedUrl: parsed };
		if (masMatch) return { id: masMatch[1], kind: "master", parsedUrl: parsed };
		return null;
	},
	notes: ["Fetched via Discogs API"],
	fetch: async (match, ctx) => {
		const isRelease = match.kind === "release";
		const apiUrl = isRelease
			? `https://api.discogs.com/releases/${match.id}`
			: `https://api.discogs.com/masters/${match.id}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: {
				Accept: "application/json",
				"User-Agent": "CodingAgent/1.0 +https://github.com/santhreal/veyyon",
			},
		});
		if (!result.ok) return ctx.scraperDegrade("discogs", ctx.loadFailure(result));

		if (isRelease) {
			const release = ctx.tryParseJson<DiscogsRelease>(result.content);
			if (!release?.title) return ctx.scraperDegrade("discogs", "unexpected response shape");
			const md = buildDiscogsReleaseMarkdown(release);
			return buildResult(md, {
				url: ctx.url,
				method: "discogs",
				fetchedAt: ctx.fetchedAt,
				notes: ["Fetched via Discogs API (release)"],
			});
		}

		const master = ctx.tryParseJson<DiscogsMaster>(result.content);
		if (!master?.title) return ctx.scraperDegrade("discogs", "unexpected response shape");
		const md = buildDiscogsMasterMarkdown(master);
		return buildResult(md, {
			url: ctx.url,
			method: "discogs",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Discogs API (master)"],
		});
	},
};

// --- MusicBrainz ---

interface MusicBrainzLifeSpan {
	begin?: string;
	end?: string;
	ended?: boolean;
}

interface MusicBrainzArtist {
	id: string;
	name: string;
	type?: string;
	country?: string;
	"life-span"?: MusicBrainzLifeSpan;
}

interface MusicBrainzArtistCredit {
	name?: string;
	artist?: {
		id?: string;
		name: string;
	};
}

interface MusicBrainzRecording {
	id: string;
	title: string;
	length?: number;
	"artist-credit"?: MusicBrainzArtistCredit[];
}

interface MusicBrainzTrack {
	id?: string;
	title?: string;
	number?: string;
	position?: number;
	length?: number;
	recording?: {
		title?: string;
		length?: number;
	};
}

interface MusicBrainzMedium {
	position?: number;
	format?: string;
	"track-count"?: number;
	tracks?: MusicBrainzTrack[];
}

interface MusicBrainzRelease {
	id: string;
	title: string;
	"track-count"?: number;
	media?: MusicBrainzMedium[];
}

const MUSICBRAINZ_MAX_TRACKS = 50;

function formatMusicBrainzLifeSpan(life: MusicBrainzLifeSpan | undefined): string | null {
	if (!life) return null;

	const begin = life.begin?.trim();
	const end = life.end?.trim();

	if (begin && end) return `${begin} - ${end}`;
	if (begin && !end) return `${begin} - ${life.ended ? "ended" : "present"}`;
	if (!begin && end) return `? - ${end}`;
	if (life.ended !== undefined) return life.ended ? "ended" : "present";

	return null;
}

function formatMusicBrainzDurationMs(lengthMs: number | undefined): string | null {
	if (!lengthMs || lengthMs <= 0) return null;
	return formatMediaDuration(Math.round(lengthMs / 1000));
}

function formatMusicBrainzArtistCredits(credits: MusicBrainzArtistCredit[] | undefined): string | null {
	if (!credits?.length) return null;

	const names = credits
		.map(credit => credit.name || credit.artist?.name)
		.filter((name): name is string => Boolean(name));

	if (!names.length) return null;
	return names.join(", ");
}

function formatMusicBrainzTrack(track: MusicBrainzTrack): string {
	const title = track.title || track.recording?.title || "Untitled";
	const duration = formatMusicBrainzDurationMs(track.length ?? track.recording?.length);
	const number = track.number || (track.position ? String(track.position) : null);

	const prefix = number ? `${number}. ` : "- ";
	let line = `${prefix}${title}`;
	if (duration) line += ` (${duration})`;
	return line;
}

function buildMusicBrainzMediumLabel(medium: MusicBrainzMedium, includePosition: boolean): string | null {
	const parts: string[] = [];
	if (includePosition && medium.position) parts.push(`Disc ${medium.position}`);
	if (medium.format) parts.push(medium.format);
	return parts.length ? parts.join(" - ") : null;
}

function buildMusicBrainzArtistMarkdown(artist: MusicBrainzArtist): string {
	let md = `# ${artist.name}\n\n`;
	const meta: string[] = [];

	if (artist.type) meta.push(`**Type**: ${artist.type}`);
	if (artist.country) meta.push(`**Country**: ${artist.country}`);

	const lifeSpan = formatMusicBrainzLifeSpan(artist["life-span"]);
	if (lifeSpan) meta.push(`**Life Span**: ${lifeSpan}`);

	if (meta.length) md += `${meta.join("\n")}\n`;

	return md;
}

function buildMusicBrainzReleaseMarkdown(release: MusicBrainzRelease): string {
	let md = `# ${release.title}\n\n`;

	const media = release.media ?? [];
	const totalTracks =
		release["track-count"] ??
		media.reduce((sum, medium) => sum + (medium["track-count"] ?? medium.tracks?.length ?? 0), 0);

	if (totalTracks) {
		md += `**Tracks**: ${totalTracks}\n\n`;
	}

	if (media.length) {
		md += "## Tracks\n\n";
		const includePosition = media.length > 1;

		for (const medium of media) {
			const label = buildMusicBrainzMediumLabel(medium, includePosition);
			if (label) md += `### ${label}\n\n`;

			const tracks = medium.tracks ?? [];
			if (tracks.length) {
				const lines = tracks.slice(0, MUSICBRAINZ_MAX_TRACKS).map(formatMusicBrainzTrack).join("\n");
				md += `${lines}\n\n`;
				if (tracks.length > MUSICBRAINZ_MAX_TRACKS) {
					md += `_Showing first ${MUSICBRAINZ_MAX_TRACKS} of ${tracks.length} tracks._\n\n`;
				}
			} else if (medium["track-count"]) {
				md += `- ${medium["track-count"]} tracks (details unavailable)\n\n`;
			}
		}
	}

	return md;
}

function buildMusicBrainzRecordingMarkdown(recording: MusicBrainzRecording): string {
	let md = `# ${recording.title}\n\n`;
	const meta: string[] = [];

	const artists = formatMusicBrainzArtistCredits(recording["artist-credit"]);
	if (artists) meta.push(`**Artists**: ${artists}`);

	const length = formatMusicBrainzDurationMs(recording.length);
	if (length) meta.push(`**Length**: ${length}`);

	if (meta.length) md += `${meta.join("\n")}\n`;

	return md;
}

export const musicbrainzDeclaration: MediaDeclaration = {
	site: "musicbrainz",
	method: "musicbrainz-api",
	hosts: ["musicbrainz.org", "www.musicbrainz.org"],
	canonicalUrls: [
		"https://musicbrainz.org/release/07545b14-fb12-4217-b9e7-57352eb5b974",
		"https://musicbrainz.org/artist/c8da2e40-3c48-4244-bc96-0f7236599691",
		"https://musicbrainz.org/recording/fcb7bc6b-8de9-4824-9549-36c1340156a0",
	],
	match: parsed => {
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 2) return null;

		const entity = parts[0].toLowerCase();
		if (entity !== "artist" && entity !== "release" && entity !== "recording") return null;

		const mbid = parts[1];
		if (!/^[0-9a-fA-F-]{36}$/.test(mbid)) return null;

		return { kind: entity, id: mbid, parsedUrl: parsed };
	},
	notes: ["Fetched via MusicBrainz API"],
	fetch: async (match, ctx) => {
		let apiUrl: string;
		if (match.kind === "artist") {
			apiUrl = `https://musicbrainz.org/ws/2/artist/${match.id}?fmt=json&inc=url-rels`;
		} else if (match.kind === "release") {
			apiUrl = `https://musicbrainz.org/ws/2/release/${match.id}?fmt=json&inc=recordings`;
		} else {
			apiUrl = `https://musicbrainz.org/ws/2/recording/${match.id}?fmt=json`;
		}

		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: {
				"User-Agent": "veyyon-web-fetch/1.0 (https://github.com/santhreal/veyyon)",
				Accept: "application/json",
			},
		});
		if (!result.ok) return ctx.scraperDegrade("musicbrainz", ctx.loadFailure(result));

		if (match.kind === "artist") {
			const artist = ctx.tryParseJson<MusicBrainzArtist>(result.content);
			if (!artist?.name) return ctx.scraperDegrade("musicbrainz", "unexpected response shape");
			return buildMusicBrainzArtistMarkdown(artist);
		}
		if (match.kind === "release") {
			const release = ctx.tryParseJson<MusicBrainzRelease>(result.content);
			if (!release?.title) return ctx.scraperDegrade("musicbrainz", "unexpected response shape");
			return buildMusicBrainzReleaseMarkdown(release);
		}
		const recording = ctx.tryParseJson<MusicBrainzRecording>(result.content);
		if (!recording?.title) return ctx.scraperDegrade("musicbrainz", "unexpected response shape");
		return buildMusicBrainzRecordingMarkdown(recording);
	},
};

// --- RAWG ---

interface RawgPlatformEntry {
	platform?: {
		name?: string;
	};
}

interface RawgGenreEntry {
	name?: string;
}

interface RawgGameResponse {
	name?: string;
	released?: string;
	rating?: number;
	platforms?: RawgPlatformEntry[];
	genres?: RawgGenreEntry[];
	description?: string;
	description_raw?: string;
	detail?: string;
	error?: string;
}

function rawgRequiresApiKey(game: RawgGameResponse): boolean {
	const detail = `${game.detail ?? ""} ${game.error ?? ""}`.toLowerCase();
	return detail.includes("api key") || detail.includes("key is required") || detail.includes("apikey");
}

function rawgCollectNames(values?: Array<string | undefined>): string[] {
	if (!values?.length) return [];
	const names = new Set<string>();
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) names.add(trimmed);
	}
	return Array.from(names);
}

async function rawgExtractDescription(game: RawgGameResponse): Promise<string | null> {
	if (game.description_raw) return game.description_raw.trim();
	if (!game.description) return null;

	const markdown = (await htmlToBasicMarkdown(game.description)).trim();
	return markdown || null;
}

export const rawgDeclaration: MediaDeclaration = {
	site: "rawg",
	method: "rawg",
	hosts: ["rawg.io", "www.rawg.io"],
	canonicalUrls: ["https://rawg.io/games/the-witcher-3-wild-hunt"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/games\/([^/?#]+)/);
		if (!match) return null;

		const slug = decodeURIComponent(match[1]).trim();
		return slug ? { id: slug, parsedUrl: parsed } : null;
	},
	notes: ["Fetched via RAWG API"],
	fetch: async (match, ctx) => {
		const slug = match.id;
		const apiUrl = `https://api.rawg.io/api/games/${encodeURIComponent(slug)}`;
		const game = await loadJson<RawgGameResponse>(ctx, apiUrl, "rawg");
		if (isScraperDegrade(game)) return game;
		if (!game) return ctx.scraperDegrade("rawg", "unexpected response shape");
		if (rawgRequiresApiKey(game)) return null;

		const title = game.name?.trim() || slug;
		let md = `# ${title}\n\n`;

		if (game.released) md += `**Released:** ${game.released}\n`;
		if (typeof game.rating === "number" && !Number.isNaN(game.rating)) {
			md += `**Rating:** ${game.rating.toFixed(2)} / 5\n`;
		}

		const platforms = rawgCollectNames(game.platforms?.map(entry => entry.platform?.name));
		if (platforms.length) md += `**Platforms:** ${platforms.join(", ")}\n`;

		const genres = rawgCollectNames(game.genres?.map(entry => entry.name));
		if (genres.length) md += `**Genres:** ${genres.join(", ")}\n`;

		md += `**RAWG:** https://rawg.io/games/${encodeURIComponent(slug)}\n`;
		md += "\n";

		const description = await rawgExtractDescription(game);
		if (description) {
			md += `## Description\n\n${description}\n`;
		}

		return md;
	},
};

// --- Spotify ---

interface SpotifyOEmbedResponse {
	title?: string;
	thumbnail_url?: string;
	provider_name?: string;
	html?: string;
	width?: number;
	height?: number;
}

interface SpotifyOpenGraphData {
	title?: string;
	description?: string;
	audio?: string;
	image?: string;
	type?: string;
	duration?: string;
	album?: string;
	musician?: string;
	artist?: string;
	releaseDate?: string;
}

function parseSpotifyOpenGraph(html: string): SpotifyOpenGraphData {
	const og: SpotifyOpenGraphData = {};
	const metaPattern = /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"[^>]*>/gi;
	let match: RegExpExecArray | null = null;

	while (true) {
		match = metaPattern.exec(html);
		if (match === null) break;
		const [, property, content] = match;

		if (property === "og:title") og.title = content;
		else if (property === "og:description") og.description = content;
		else if (property === "og:audio") og.audio = content;
		else if (property === "og:image") og.image = content;
		else if (property === "og:type") og.type = content;
		else if (property === "music:duration") og.duration = content;
		else if (property === "music:album") og.album = content;
		else if (property === "music:musician") og.musician = content;
		else if (property === "music:release_date") og.releaseDate = content;
		else if (property === "twitter:audio:artist_name") og.artist = content;
	}

	return og;
}

function getSpotifyContentType(url: string): string | null {
	if (url.includes("/episode/")) return "podcast-episode";
	if (url.includes("/show/")) return "podcast-show";
	if (url.includes("/track/")) return "track";
	if (url.includes("/album/")) return "album";
	if (url.includes("/playlist/")) return "playlist";
	return null;
}

function formatSpotifyDurationSeconds(seconds: string | undefined): string | null {
	if (!seconds) return null;
	const num = Number.parseInt(seconds, 10);
	if (Number.isNaN(num)) return null;
	return formatMediaDuration(num);
}

function formatSpotifyOutput(
	contentType: string,
	oEmbed: SpotifyOEmbedResponse,
	og: SpotifyOpenGraphData,
	url: string,
): string {
	const sections: string[] = [];

	const title = og.title || oEmbed.title || "Unknown";
	sections.push(`# ${title}\n`);

	sections.push(`**Type**: ${contentType}\n`);

	if (og.description) {
		sections.push(`**Description**: ${og.description}\n`);
	}

	if (contentType === "track" || contentType === "podcast-episode") {
		if (og.artist || og.musician) {
			sections.push(`**Artist**: ${og.artist || og.musician}\n`);
		}
		if (og.album) {
			sections.push(`**Album**: ${og.album}\n`);
		}
		if (og.duration) {
			const formatted = formatSpotifyDurationSeconds(og.duration);
			if (formatted) {
				sections.push(`**Duration**: ${formatted}\n`);
			}
		}
	}

	if (contentType === "album" && og.releaseDate) {
		sections.push(`**Release Date**: ${og.releaseDate}\n`);
	}

	sections.push("\n---\n");
	if (contentType === "playlist") {
		sections.push(
			"**Note**: Playlist details (tracks, creator, follower count) require authentication. " +
				"Only basic metadata is available without Spotify API credentials.\n",
		);
	} else if (contentType === "album") {
		sections.push(
			"**Note**: Track listing and detailed album information require authentication. " +
				"Only basic metadata is available without Spotify API credentials.\n",
		);
	} else if (contentType === "podcast-show") {
		sections.push(
			"**Note**: Episode listing and detailed show information require authentication. " +
				"Only basic metadata is available without Spotify API credentials.\n",
		);
	}

	sections.push(`**URL**: ${url}\n`);

	if (oEmbed.thumbnail_url) {
		sections.push(`**Thumbnail**: ${oEmbed.thumbnail_url}\n`);
	} else if (og.image) {
		sections.push(`**Image**: ${og.image}\n`);
	}

	return sections.join("\n");
}

export const spotifyDeclaration: MediaDeclaration = {
	site: "spotify",
	method: "spotify",
	hosts: ["open.spotify.com"],
	canonicalUrls: [
		"https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
		"https://open.spotify.com/album/4m28ee0Q95grY5SODvQU29",
		"https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
		"https://open.spotify.com/episode/776lbv8e5HH4ag9VBJHQxD",
		"https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk",
	],
	match: parsed => {
		const contentType = getSpotifyContentType(parsed.href);
		if (!contentType) return null;
		return { id: contentType, kind: contentType, parsedUrl: parsed };
	},
	notes: ["Fetched via Spotify oEmbed and OpenGraph"],
	fetch: async (match, ctx) => {
		const contentType = match.kind ?? getSpotifyContentType(ctx.url);
		if (!contentType) return null;

		const notes: string[] = [];
		let oEmbedData: SpotifyOEmbedResponse = {};
		let ogData: SpotifyOpenGraphData = {};

		try {
			const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(ctx.url)}`;
			const response = await ctx.loadPage(oEmbedUrl, { timeout: ctx.timeout, signal: ctx.signal });

			if (response.ok) {
				const parsedJson = ctx.tryParseJson<SpotifyOEmbedResponse>(response.content);
				if (parsedJson) {
					oEmbedData = parsedJson;
					notes.push("Retrieved metadata via Spotify oEmbed API");
				} else {
					notes.push("Failed to parse oEmbed JSON");
				}
			} else {
				notes.push(`oEmbed API returned status ${response.status || "error"}`);
			}
		} catch (err) {
			if (isCancellation(err)) throw err;
			notes.push(`Failed to fetch oEmbed data: ${errorMessage(err)}`);
		}

		try {
			const pageResponse = await ctx.loadPage(ctx.url, { timeout: ctx.timeout, signal: ctx.signal });

			if (pageResponse.ok) {
				ogData = parseSpotifyOpenGraph(pageResponse.content);
				notes.push("Parsed Open Graph metadata from page HTML");
			} else {
				notes.push(`Page fetch returned status ${pageResponse.status || "error"}`);
			}
		} catch (err) {
			if (isCancellation(err)) throw err;
			notes.push(`Failed to fetch page HTML: ${errorMessage(err)}`);
		}

		if (!oEmbedData.title && !ogData.title) {
			return ctx.scraperDegrade("spotify", "could not retrieve metadata");
		}

		const output = formatSpotifyOutput(contentType, oEmbedData, ogData, ctx.url);
		return buildResult(output, {
			url: ctx.url,
			method: "spotify",
			fetchedAt: ctx.fetchedAt,
			notes,
		});
	},
};

// --- Vimeo ---

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

function extractVimeoVideoId(url: URL): string | null {
	if (url.hostname === "player.vimeo.com") {
		const match = url.pathname.match(/^\/video\/(\d+)/);
		return match?.[1] ?? null;
	}

	if (url.hostname === "vimeo.com" || url.hostname === "www.vimeo.com") {
		const parts = url.pathname.split("/").filter(Boolean);
		const lastPart = parts[parts.length - 1];
		if (lastPart && /^\d+$/.test(lastPart)) {
			return lastPart;
		}
	}

	return null;
}

export const vimeoDeclaration: MediaDeclaration = {
	site: "vimeo",
	method: "vimeo",
	hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
	canonicalUrls: [
		"https://vimeo.com/76979871",
		"https://player.vimeo.com/video/76979871",
		"https://vimeo.com/channels/staffpicks/76979871",
	],
	match: parsed => {
		const videoId = extractVimeoVideoId(parsed);
		return videoId ? { id: videoId, parsedUrl: parsed } : null;
	},
	notes: ["Fetched via Vimeo oEmbed API"],
	fetch: async (match, ctx) => {
		const videoId = match.id;
		const canonicalUrl = `https://vimeo.com/${videoId}`;
		const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonicalUrl)}`;
		const oembed = await loadJson<VimeoOEmbed>(ctx, oembedUrl, "vimeo");
		if (isScraperDegrade(oembed)) return oembed;
		if (!oembed?.title) return ctx.scraperDegrade("vimeo", "unexpected response shape");
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
			const configResult = await ctx.loadPage(configUrl, { timeout: Math.min(ctx.timeout, 5), signal: ctx.signal });

			if (configResult.ok) {
				const config = ctx.tryParseJson<VimeoVideoConfig>(configResult.content);
				const progressive = config?.request?.files?.progressive;
				if (progressive && progressive.length > 0) {
					md += `\n**Available Qualities:**\n`;
					for (const quality of progressive.slice(0, 5)) {
						md += `- ${quality.quality}: ${quality.width}x${quality.height} @ ${quality.fps}fps\n`;
					}
				}
			}
		} catch {
			// Config fetch is optional
		}

		return md;
	},
};

export const MEDIA_DECLARATIONS = [
	discogsDeclaration,
	musicbrainzDeclaration,
	rawgDeclaration,
	spotifyDeclaration,
	vimeoDeclaration,
];
