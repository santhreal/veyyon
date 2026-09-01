import { type ParseSessionResult, parseSessionFile } from "./parser";

export type SyncWorkerRequest = { kind?: "parse"; sessionFile: string; fromOffset: number } | { kind: "ping" };

export type SyncWorkerResponse =
	| { ok: true; kind?: "parse"; result: ParseSessionResult }
	| { ok: true; kind: "pong" }
	| { ok: false; error: string };

declare const self: Worker & {
	onmessage: ((event: MessageEvent<SyncWorkerRequest>) => void) | null;
};

self.onmessage = async event => {
	const request = event.data;
	try {
		if (request.kind === "ping") {
			self.postMessage({ ok: true, kind: "pong" } satisfies SyncWorkerResponse);
			return;
		}
		const result = await parseSessionFile(request.sessionFile, request.fromOffset);
		self.postMessage({ ok: true, result } satisfies SyncWorkerResponse);
	} catch (err) {
		const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		self.postMessage({ ok: false, error } satisfies SyncWorkerResponse);
	}
};
