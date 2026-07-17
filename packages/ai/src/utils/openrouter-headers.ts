import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `Veyyon/${packageJson.version}`,
		"HTTP-Referer": "https://veyyon.dev/",
		"X-OpenRouter-Title": "Veyyon",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
