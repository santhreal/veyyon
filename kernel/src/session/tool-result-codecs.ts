/**
 * The tool-name-keyed table of result codecs the domains contributed, and the three passes that apply
 * it: {@link slimToolResultEntry} on the line a session writes, {@link restoreToolResultEntries} on
 * the entries a session loads, and {@link settleToolResultMessage} on a result a persisting session
 * records.
 *
 * The table is filled where the tool domains are assembled, from each manifest's `resultCodecs`,
 * which a host imports before it opens a session. A load that runs with no codec registered leaves a
 * slimmed field absent rather than wrong; a host that draws such an entry rebuilds the field from
 * the result's content itself.
 *
 * ONE OWNER PER TOOL. Registering a second codec for a tool another codec claims throws, since two
 * codecs for one tool means what a session file holds depends on load order. The same codec
 * registered twice is a no-op, so a composition root may run more than once in one process.
 */
import type { ToolResultMessage } from "@veyyon/ai";
import type { ToolResultCodec } from "../registry/tool-result-codec";
import type { FileEntry } from "./session-entries";

const codecs = new Map<string, ToolResultCodec>();

export function registerToolResultCodecs(contributed: readonly ToolResultCodec[]): void {
	for (const codec of contributed) {
		const existing = codecs.get(codec.toolName);
		if (existing === codec) continue;
		if (existing !== undefined) {
			throw new Error(
				`tool "${codec.toolName}" already has a result codec; a tool's results are stored by one domain manifest's resultCodecs`,
			);
		}
		codecs.set(codec.toolName, codec);
	}
}

/** The tool result an entry holds with its tool's codec, or undefined when either is missing. */
function codedResult(entry: FileEntry): { message: ToolResultMessage; codec: ToolResultCodec } | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	const message = entry.message;
	if (message.details === undefined) return undefined;
	const codec = codecs.get(message.toolName);
	return codec === undefined ? undefined : { message, codec };
}

/**
 * The entry as a session writes it: a tool result's details slimmed by its tool's codec against the
 * content the same entry holds. Returns `entry` itself when nothing is dropped, and never mutates it.
 */
export function slimToolResultEntry(entry: FileEntry): FileEntry {
	const coded = codedResult(entry);
	if (coded === undefined) return entry;
	const { message, codec } = coded;
	const details = codec.slim(message.details, message.content);
	if (details === message.details) return entry;
	return { ...entry, message: { ...message, details } } as FileEntry;
}

/**
 * Rebuild in place what {@link slimToolResultEntry} dropped from each loaded tool result. Runs after
 * externalized payloads are restored, since a codec reads the content the line was written with.
 */
export function restoreToolResultEntries(entries: readonly FileEntry[]): void {
	if (codecs.size === 0) return;
	for (const entry of entries) {
		const coded = codedResult(entry);
		coded?.codec.restore(coded.message.details, coded.message.content);
	}
}

/**
 * Settle a tool result a persisting session records, before its line is written: its tool's codec
 * replaces in place, in `message.details`, what the line drops with the form a load rebuilds, so the
 * entry the session holds while it runs contains the repeated text once.
 */
export function settleToolResultMessage(message: ToolResultMessage): void {
	if (message.details === undefined) return;
	codecs.get(message.toolName)?.settle?.(message.details, message.content);
}
