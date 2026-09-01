import type { RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, loadPage, scraperDegrade, tryParseUrl } from "./types";

export const handleCheatSh: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		if (parsed.hostname !== "cheat.sh" && parsed.hostname !== "cht.sh") return null;

		const topic = parsed.pathname.slice(1);
		if (!topic || topic === "" || topic === "/") return null;

		const fetchedAt = new Date().toISOString();

		const apiUrl = `https://cheat.sh/${encodeURIComponent(topic)}?T`;
		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: {
				Accept: "text/plain",
			},
		});

		if (!result.ok || !result.content.trim()) return null;

		const decodedTopic = decodeURIComponent(topic);
		let md = `# cheat.sh/${decodedTopic}\n\n`;

		const content = result.content.trim();
		const lines = content.split("\n");
		const hasCodeIndicators = lines.some(
			line =>
				line.startsWith("$") ||
				line.startsWith("#") ||
				line.includes("()") ||
				line.includes("=>") ||
				/^\s*(if|for|while|def|func|fn|let|const|var)\b/.test(line),
		);

		if (hasCodeIndicators || decodedTopic.includes("/")) {
			const lang = decodedTopic.split("/")[0] || "bash";
			md += `\`\`\`${lang}\n${content}\n\`\`\`\n`;
		} else {
			md += `\`\`\`\n${content}\n\`\`\`\n`;
		}

		return buildResult(md, { url, method: "cheat.sh", fetchedAt, notes: ["Fetched via cheat.sh"] });
	} catch (error) {
		return scraperDegrade("cheatsh", error);
	}
};
