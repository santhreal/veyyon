import { BlobStore } from "@veyyon/kernel/session/blob-store";
import type { SessionEntry, SessionHeader } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { migrateToCurrentVersion } from "@veyyon/kernel/session/session-migrations";
import { contentText } from "@veyyon/utils/content-text";
import { getBlobsDir } from "@veyyon/utils/dirs";
import { sessionInfoToSummary } from "../session-bridge";
import { sessionEntriesToTranscript } from "../transcript-conversion";
import type { SessionSummary } from "../wire";
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

export const historyActionHandlers: ActionHandlersMap = {
	SearchSessions: searchSessions,
	PreviewSessionTranscript: previewSession,
};
