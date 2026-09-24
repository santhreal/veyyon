import { BlobStore } from "@veyyon/kernel/session/blob-store";
import { type HistoryEntry, HistoryStorage } from "@veyyon/kernel/session/history-storage";
import type { SessionEntry, SessionHeader } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { migrateToCurrentVersion } from "@veyyon/kernel/session/session-migrations";
import { logger } from "@veyyon/utils";
import { contentText } from "@veyyon/utils/content-text";
import { getBlobsDir, getProjectDir } from "@veyyon/utils/dirs";
import { sessionInfoToSummary } from "../session-bridge";
import { sessionEntriesToTranscript } from "../transcript-conversion";
import type { PromptHistoryEntryView, SessionSummary } from "../wire";
import { replyError, sessionStorage } from "./active-session";
import { sessionFiles } from "./session-files";
import type { ActionHandler, ActionHandlersMap } from "./types";

async function readHistory(file: string): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
	const loaded = await loadEntriesFromFile(file, sessionStorage);
	const header = loaded[0];
	if (header?.type !== "session") throw new Error(`Session '${file}' has no readable session header`);
	migrateToCurrentVersion(loaded);
	await resolveBlobRefsInEntries(loaded, new BlobStore(getBlobsDir()));
	return { header, entries: loaded.filter((entry): entry is SessionEntry => entry.type !== "session") };
}

const searchSessions: ActionHandler<{ query?: string } | undefined> = async (ctx, payload) => {
	if (typeof payload?.query !== "string") {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "SearchSessions requires query",
			retryable: false,
		});
		return;
	}
	try {
		const query = payload.query.trim().toLocaleLowerCase();
		const sessions: SessionSummary[] = [];
		for (const file of await sessionFiles(ctx.agentDir)) {
			const { header, entries } = await readHistory(file);
			const messages = entries.filter(entry => entry.type === "message");
			const texts = messages.map(entry =>
				contentText("content" in entry.message ? entry.message.content : undefined, { separator: " " }),
			);
			if (
				query &&
				![header.title ?? "", header.cwd, ...texts].some(value => value.toLocaleLowerCase().includes(query))
			)
				continue;
			const stat = sessionStorage.statSync(file);
			sessions.push(
				sessionInfoToSummary({
					path: file,
					id: header.id,
					cwd: header.cwd,
					title: header.title,
					parentSessionPath: header.parentSession,
					created: new Date(header.timestamp),
					modified: stat.mtime,
					messageCount: messages.length,
					size: stat.size,
					firstMessage: texts[messages.findIndex(entry => entry.message.role === "user")] ?? "",
					// The host matched the whole transcript; do not ship a second copy in the index.
					allMessagesText: "",
				}),
			);
		}
		sessions.sort((a, b) => b.modified_at_ms - a.modified_at_ms || a.path.localeCompare(b.path));
		ctx.reply.snapshot({ SessionSearch: { query: payload.query, sessions } });
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "SEARCH_SESSIONS_FAILED", error);
	}
};

const previewSession: ActionHandler<{ session?: string } | undefined> = async (ctx, payload) => {
	if (typeof payload?.session !== "string" || !payload.session.trim()) {
		ctx.reply.failure({
			scope: "Transcript",
			code: "INVALID_ARGUMENTS",
			message: "PreviewSessionTranscript requires session",
			retryable: false,
		});
		return;
	}
	try {
		const files = await sessionFiles(ctx.agentDir);
		let file = files.find(candidate => candidate === payload.session);
		if (!file) {
			for (const candidate of files) {
				if ((await readHistory(candidate)).header.id === payload.session) {
					file = candidate;
					break;
				}
			}
		}
		if (!file) {
			ctx.reply.failure({
				scope: "Transcript",
				code: "SESSION_NOT_FOUND",
				message: `Session '${payload.session}' was not found`,
				retryable: false,
			});
			return;
		}
		const { entries } = await readHistory(file);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			SessionTranscript: {
				session: payload.session,
				transcript: {
					revision: ctx.clientState.revision,
					value: sessionEntriesToTranscript(entries, ctx.clientState.revision),
				},
			},
		});
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "PREVIEW_SESSION_FAILED", error, "Transcript");
	}
};

/** Prompts returned for one lookup, matching what the window can rank. */
const PROMPT_HISTORY_LIMIT = 200;

/** Longest prompt sent whole; a longer one arrives cut and says so. */
const PROMPT_HISTORY_MAX_CHARS = 400;

function toPromptView(entry: HistoryEntry): PromptHistoryEntryView {
	const truncated = entry.prompt.length > PROMPT_HISTORY_MAX_CHARS;
	return {
		id: entry.id,
		prompt: truncated ? entry.prompt.slice(0, PROMPT_HISTORY_MAX_CHARS) : entry.prompt,
		submitted_at_ms: entry.created_at * 1000,
		cwd: entry.cwd ?? null,
		session: entry.sessionId ?? null,
		truncated,
	};
}

/**
 * The prompts submitted earlier that match `query`, most recent first.
 *
 * The store is the one a terminal writes from its editor and a window writes
 * through `recordSubmittedPrompt`, so a prompt typed in either front end is
 * recalled in both. An empty query is answered with the most recent prompts
 * rather than with nothing, which is what the window opens the mode on.
 */
const searchPromptHistory: ActionHandler<{ query?: string } | undefined> = (ctx, payload) => {
	const query = typeof payload?.query === "string" ? payload.query.trim() : "";
	try {
		const storage = HistoryStorage.open();
		const entries =
			query.length === 0 ? storage.getRecent(PROMPT_HISTORY_LIMIT) : storage.search(query, PROMPT_HISTORY_LIMIT);
		ctx.reply.snapshot({
			PromptHistory: { query: payload?.query ?? "", entries: entries.map(toPromptView) },
		});
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "SEARCH_PROMPT_HISTORY_FAILED", error);
	}
};

/**
 * Records `prompt` as submitted from `session`, so a prompt typed in a window
 * is recalled the way one typed in a terminal is. A terminal writes this row
 * from its editor on submit; a window submits over the protocol and never
 * reaches that editor, so the write is here.
 *
 * A row that cannot be written is logged and nothing else: the turn has been
 * accepted by the time this runs, and refusing it over a history row would
 * discard work nobody asked to discard. Consecutive duplicates and empty
 * prompts are dropped by the store itself.
 */
export function recordSubmittedPrompt(prompt: string, session: string): void {
	try {
		void HistoryStorage.open()
			.add(prompt, getProjectDir(), session)
			.catch(error => logger.error("Prompt history add failed", { error: String(error) }));
	} catch (error) {
		logger.error("Prompt history open failed", { error: String(error) });
	}
}

export const historyActionHandlers: ActionHandlersMap = {
	SearchSessions: searchSessions,
	PreviewSessionTranscript: previewSession,
	SearchPromptHistory: searchPromptHistory,
};
