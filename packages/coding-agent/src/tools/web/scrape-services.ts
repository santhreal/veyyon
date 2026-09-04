import type { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import type { DocumentConversion, ScrapeServices } from "@veyyon/web/scrapers/types";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../config/settings-instance";
import { primarySessionCpuAdoption } from "../../session/cpu-limit";
import { convertBufferWithMarkit } from "../../utils/markit";
import { ensureTool, type ToolName } from "../../utils/tools-manager";

const MANAGED_TOOLS: readonly ToolName[] = ["sd", "sg", "yt-dlp", "trafilatura", "ffmpeg"];

/** Convert a fetched document to markdown under its own deadline. */
export async function convertDocument(
	buffer: Uint8Array,
	extension: string,
	timeout: number = 20,
	signal?: AbortSignal,
): Promise<DocumentConversion> {
	const conversionTimeout = scopedTimeoutSignal(timeout * 1000, signal);
	try {
		return await convertBufferWithMarkit(buffer, extension, conversionTimeout.signal);
	} finally {
		conversionTimeout.cancel();
	}
}

/**
 * The host capabilities `@veyyon/web` runs its site scrapers against.
 *
 * A scraper reaches nothing in this package: the credential store, the document converter, the
 * managed external tools, the session CPU spawn hook and the operator's reader preference all
 * arrive through this object, built once per fetch.
 */
export function scrapeServices(storage: AgentStorage | null | undefined): ScrapeServices {
	return {
		credentials: storage,
		convertDocument,
		async ensureTool(name, options) {
			// A name this host does not manage is answered with null rather than installed: the
			// resolver is keyed by a closed set, and an unknown name is a caller defect, not a
			// download.
			if (!(MANAGED_TOOLS as readonly string[]).includes(name)) return null;
			return (await ensureTool(name as ToolName, options)) ?? null;
		},
		spawnHook: primarySessionCpuAdoption,
		fetchPreference: () => settings.get("providers.fetch"),
	};
}
