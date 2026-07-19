import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "./types";
import { finiteNumber, isRecord, trimmedString } from "./utils";

function formatLicenses(licenses: unknown): string[] {
	if (!Array.isArray(licenses)) return [];
	const output: string[] = [];
	for (const license of licenses) {
		if (typeof license === "string") {
			const trimmed = license.trim();
			if (trimmed) output.push(trimmed);
			continue;
		}
		if (isRecord(license)) {
			const name = trimmedString(license.name);
			const url = trimmedString(license.url);
			if (name && url) {
				output.push(`${name} (${url})`);
			} else if (name) {
				output.push(name);
			} else if (url) {
				output.push(url);
			}
		}
	}
	return output;
}

function formatDependencies(deps: unknown): string[] {
	const output: string[] = [];
	if (Array.isArray(deps)) {
		for (const dep of deps) {
			if (typeof dep === "string") {
				const trimmed = dep.trim();
				if (trimmed) output.push(trimmed);
				continue;
			}
			if (Array.isArray(dep)) {
				const name = trimmedString(dep[0]);
				const version = trimmedString(dep[1]);
				if (name && version) {
					output.push(`${name}: ${version}`);
				} else if (name) {
					output.push(name);
				}
				continue;
			}
			if (isRecord(dep)) {
				const name = trimmedString(dep.name) ?? trimmedString(dep.artifact) ?? trimmedString(dep.jar_name);
				const version = trimmedString(dep.version);
				if (name && version) {
					output.push(`${name}: ${version}`);
				} else if (name) {
					output.push(name);
				}
			}
		}
		return output;
	}

	if (isRecord(deps)) {
		for (const [name, version] of Object.entries(deps)) {
			const versionText = trimmedString(version);
			if (versionText) {
				output.push(`${name}: ${versionText}`);
			} else if (name.trim()) {
				output.push(name);
			}
		}
	}

	return output;
}

/**
 * Handle Clojars URLs via API
 */
export const handleClojars: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		if (parsed.hostname !== "clojars.org" && parsed.hostname !== "www.clojars.org") return null;

		const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
		if (!path) return null;

		const segments = path.split("/").filter(Boolean);
		if (segments.length < 1 || segments.length > 2) return null;

		const groupFromUrl = segments.length === 2 ? decodeURIComponent(segments[0]) : null;
		const artifactFromUrl = decodeURIComponent(segments[segments.length - 1]);

		const apiUrl =
			segments.length === 2
				? `https://clojars.org/api/artifacts/${encodeURIComponent(groupFromUrl ?? "")}/${encodeURIComponent(artifactFromUrl)}`
				: `https://clojars.org/api/artifacts/${encodeURIComponent(artifactFromUrl)}`;

		const fetchedAt = new Date().toISOString();

		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return scraperDegrade("clojars", loadFailure(result));

		const payload = tryParseJson(result.content);
		if (!payload) return null;

		const data = Array.isArray(payload) ? payload[0] : payload;
		if (!isRecord(data)) return null;

		const groupName = trimmedString(data.group_name) ?? trimmedString(data.group) ?? groupFromUrl;
		const artifactName =
			trimmedString(data.jar_name) ?? trimmedString(data.artifact) ?? trimmedString(data.name) ?? artifactFromUrl;
		const version = trimmedString(data.latest_version) ?? trimmedString(data.version);
		const description = trimmedString(data.description) ?? trimmedString(data.summary);
		const downloads =
			finiteNumber(data.downloads) ??
			finiteNumber(data.downloads_total) ??
			finiteNumber(data.total_downloads) ??
			null;
		const homepage = trimmedString(data.homepage) ?? trimmedString(data.url);
		const licenses = formatLicenses(data.licenses);
		const dependencies = formatDependencies(data.dependencies ?? data.deps);

		const displayName =
			groupName && artifactName && groupName !== artifactName
				? `${groupName}/${artifactName}`
				: (artifactName ?? groupName ?? "Clojars artifact");

		let md = `# ${displayName}\n\n`;
		if (description) md += `${description}\n\n`;

		if (groupName) md += `**Group:** ${groupName}\n`;
		if (artifactName) md += `**Artifact:** ${artifactName}\n`;
		if (version) md += `**Latest:** ${version}\n`;
		if (downloads !== null) md += `**Downloads:** ${formatNumber(downloads)}\n`;
		if (homepage) md += `**Homepage:** ${homepage}\n`;
		if (licenses.length > 0) md += `**Licenses:** ${licenses.join(", ")}\n`;

		if (dependencies.length > 0) {
			md += "\n## Dependencies\n\n";
			for (const dep of dependencies) {
				md += `- ${dep}\n`;
			}
		}

		return buildResult(md, { url, method: "clojars", fetchedAt, notes: ["Fetched via Clojars API"] });
	} catch (error) {
		return scraperDegrade("clojars", error);
	}
};
