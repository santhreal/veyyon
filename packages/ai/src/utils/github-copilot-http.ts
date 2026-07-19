/**
 * Shared HTTP helper for the GitHub Copilot integration.
 *
 * The usage provider (usage/github-copilot.ts) and the OAuth flow
 * (registry/oauth/github-copilot.ts) both talk to the same GitHub / Copilot
 * REST endpoints and expect the same failure contract: throw a
 * {@link AIError.ProviderHttpError} carrying `status statusText: body` on any
 * non-2xx response, and parse the body as JSON otherwise. This is the ONE owner
 * for that fetch-and-throw shape; both call sites pass their own fetch impl
 * (the usage context's `ctx.fetch`, or the OAuth flow's injected `fetchImpl`).
 */

import type { FetchImpl } from "@veyyon/catalog/types";
import * as AIError from "../error";

export async function fetchGitHubCopilotJson(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<unknown> {
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new AIError.ProviderHttpError(`${response.status} ${response.statusText}: ${text}`, response.status);
	}
	return response.json();
}
