import packageJson from "../../package.json" with { type: "json" };

/**
 * The user agent OpenCode gateway traffic carries.
 *
 * OpenCode requires a narrow client user agent on requests to
 * `https://opencode.ai/zen/v1` and `https://opencode.ai/zen/go/v1`, and flags
 * traffic that sends none. Model discovery reads the same gateway with the same
 * API key as a completion request, so the header belongs on both paths, not
 * only on the streaming transports.
 *
 * Defined here rather than in the request layer because catalog discovery is
 * the earlier consumer: `@veyyon/catalog` cannot import `@veyyon/ai`, and a
 * second copy of the string in the request layer is how the two drift.
 */
export function getOpenCodeUserAgent(): string {
	return `Veyyon/${packageJson.version}`;
}
