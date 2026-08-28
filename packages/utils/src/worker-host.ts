import { stripWindowsExtendedLengthPathPrefix } from "./path";

let workerHostMain: string | null = null;

export function declareWorkerHostEntry(): void {
	workerHostMain = stripWindowsExtendedLengthPathPrefix(Bun.main);
}

export function workerHostEntry(): string | null {
	return workerHostMain;
}

export interface WorkerInbox {
	bind(handler: (message: unknown) => void): () => void;
}

interface MessageListenerPort {
	on(event: "message", listener: (value: unknown) => void): unknown;
}

let pendingInbox: WorkerInbox | null = null;

export function installWorkerInbox(port: MessageListenerPort): WorkerInbox {
	const queue: unknown[] = [];
	let handler: ((message: unknown) => void) | null = null;
	port.on("message", (data: unknown) => {
		if (handler) handler(data);
		else queue.push(data);
	});
	const inbox: WorkerInbox = {
		bind(next) {
			handler = next;
			for (const data of queue) next(data);
			queue.length = 0;
			return () => {
				if (handler === next) handler = null;
			};
		},
	};
	pendingInbox = inbox;
	return inbox;
}

export function consumeWorkerInbox(): WorkerInbox | null {
	const inbox = pendingInbox;
	pendingInbox = null;
	return inbox;
}
