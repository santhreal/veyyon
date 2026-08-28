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
