/**
 * Shared helpers for /mcp and /ssh command controllers.
 *
 * Captures argument parsing, source grouping, and chat-message rendering that
 * was duplicated between mcp-command-controller and ssh-command-controller.
 * Intentionally kept narrow: subcommand routing, help text, success/error
 * wording, and add-flow logic stay in the per-controller files because they
 * diverge in workflow.
 */
import type { SourceMeta } from "../../capability/types";
import { shortenPath } from "../../tools/render-utils";
import { mountTranscriptBlock, transcriptBlockText } from "../components/transcript-block-chrome";
import { TranscriptBlock } from "../components/transcript-container";
import type { InteractiveModeContext } from "../types";

/**
 * Group capability-loaded items by their source provider+path, yielding each
 * group with a display-ready `shortPath`.
 */
export function* groupBySource<T>(
	items: Iterable<T>,
	getSource: (item: T) => SourceMeta,
): Iterable<{ providerName: string; shortPath: string; items: T[] }> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const src = getSource(item);
		const key = `${src.providerName}|${src.path}`;
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(item);
	}
	for (const [key, grouped] of groups) {
		const sepIdx = key.indexOf("|");
		yield {
			providerName: key.slice(0, sepIdx),
			shortPath: shortenPath(key.slice(sepIdx + 1)),
			items: grouped,
		};
	}
}

/**
 * Present a message block on the transcript rail. Reads one member, so it asks
 * for one: controllers that have been narrowed to their own slice can still
 * call it.
 */
export function showCommandMessage(ctx: Pick<InteractiveModeContext, "present">, text: string): void {
	const block = new TranscriptBlock();
	mountTranscriptBlock(block, { body: transcriptBlockText(text) });
	ctx.present(block);
}
