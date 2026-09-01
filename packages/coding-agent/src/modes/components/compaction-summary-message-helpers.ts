import { resolveServerCompactionTransport } from "@veyyon/agent-core/compaction";
import type { Api, Model } from "@veyyon/ai";

export function willCompactRemotely(session: {
	settings: { get(key: "compaction.remote"): unknown };
	model: Model<Api> | undefined;
}): boolean {
	if (session.settings.get("compaction.remote") !== true) return false;
	return !!session.model && resolveServerCompactionTransport(session.model) !== undefined;
}

export function compactionActionLabel(isAuto: boolean, remote: boolean): string {
	const base = isAuto ? "Auto-compacting context" : "Compacting context...";
	return remote ? `${base} (openai remote compaction)` : base;
}

export interface SummaryDividerOptions {
	label: () => string;
	detailMarkdown: () => string;
	hint: () => string;
}
