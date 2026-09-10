import * as net from "node:net";

export interface RequestFrame {
	RequestSucceeded?: { request: number };
	RequestFailed?: { request: number; error: { scope: string; code: string; message: string; retryable: boolean } };
	Snapshot?: Record<string, unknown>;
	TranscriptAppended?: { revision: number; entries: unknown[] };
	[key: string]: unknown;
}

export class TestSocketClient {
	#socket: net.Socket;
	#buffer = Buffer.alloc(0);
	#frames: unknown[] = [];
	#waiters: Array<{ resolve: (frame: unknown) => void; reject: (err: Error) => void }> = [];
	#closeWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
	#isClosed = false;
	#largestFrameBytes = 0;

	constructor(socket: net.Socket) {
		this.#socket = socket;

		this.#socket.on("data", (chunk: Buffer) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			while (this.#buffer.length > 0) {
				const newlineIndex = this.#buffer.indexOf(0x0a);
				if (newlineIndex === -1) break;

				const rawLine = this.#buffer.subarray(0, newlineIndex);
				this.#largestFrameBytes = Math.max(this.#largestFrameBytes, rawLine.length + 1);
				this.#buffer = this.#buffer.subarray(newlineIndex + 1);

				const line = rawLine.toString("utf8").trim();
				if (!line) continue;

				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}

				if (this.#waiters.length > 0) {
					const waiter = this.#waiters.shift()!;
					waiter.resolve(parsed);
				} else {
					this.#frames.push(parsed);
				}
			}
		});

		this.#socket.on("close", () => {
			this.#isClosed = true;
			for (const waiter of this.#closeWaiters) waiter.resolve();
			this.#closeWaiters = [];
			for (const waiter of this.#waiters) waiter.reject(new Error("Socket closed"));
			this.#waiters = [];
		});

		this.#socket.on("error", (err: Error) => {
			for (const waiter of this.#waiters) waiter.reject(err);
			this.#waiters = [];
		});
	}

	static async connect(endpoint: string): Promise<TestSocketClient> {
		const { promise, resolve, reject } = Promise.withResolvers<TestSocketClient>();
		let socket: net.Socket;
		if (endpoint.startsWith("unix:")) {
			socket = net.createConnection(endpoint.slice(5));
		} else if (endpoint.startsWith("tcp:")) {
			const authority = endpoint.slice(4);
			const colonIndex = authority.lastIndexOf(":");
			const host = authority.slice(0, colonIndex) || "127.0.0.1";
			const port = Number.parseInt(authority.slice(colonIndex + 1), 10);
			socket = net.createConnection({ host, port });
		} else {
			throw new Error(`Unsupported endpoint format: ${endpoint}`);
		}

		socket.on("connect", () => resolve(new TestSocketClient(socket)));
		socket.on("error", err => reject(err));
		return await promise;
	}

	async nextFrame(): Promise<unknown> {
		if (this.#frames.length > 0) return this.#frames.shift();
		if (this.#isClosed) throw new Error("Socket is closed");
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#waiters.push({ resolve, reject });
		return await promise;
	}

	/**
	 * The largest frame this client has read, in bytes on the wire including
	 * its newline. Read from the raw line rather than from the parsed value,
	 * because the cap the window's decoder enforces is a byte count.
	 */
	largestFrameBytes(): number {
		return this.#largestFrameBytes;
	}

	send(value: unknown): void {
		this.#socket.write(`${JSON.stringify(value)}\n`, "utf8");
	}

	/**
	 * Send one request and collect every frame the host emits for it, up to and
	 * including its terminal `RequestSucceeded` / `RequestFailed`. Frames that
	 * belong to another request id are kept in order too, since a handler's
	 * side effects (an appended transcript entry, a snapshot) carry no id.
	 */
	async request(id: number, action: unknown): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
		this.send({ id, action });
		const frames: RequestFrame[] = [];
		for (;;) {
			const frame = (await this.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (frame.RequestSucceeded?.request === id || frame.RequestFailed?.request === id) {
				return { frames, outcome: frame };
			}
		}
	}

	sendRaw(data: Buffer | string): void {
		this.#socket.write(data);
	}

	async waitForClose(): Promise<void> {
		if (this.#isClosed) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#closeWaiters.push({ resolve, reject });
		await promise;
	}

	destroy(): void {
		this.#socket.destroy();
	}
}

/**
 * Every value one snapshot section carried across the frames of one request.
 *
 * A request's frames are not only its own. A live terminal writes its PTY
 * output whenever the shell produces it, so the frame at index 0 is whichever
 * frame arrived first, which under load is a chunk of shell output rather than
 * the snapshot the request asked for. Selecting by section, and by the property
 * that identifies the frame the request produced, is what the caller means.
 */
export function snapshotSections<T>(frames: RequestFrame[], section: string): T[] {
	return frames
		.filter((frame): frame is RequestFrame & { Snapshot: Record<string, unknown> } =>
			Boolean(frame.Snapshot && section in frame.Snapshot),
		)
		.map(frame => frame.Snapshot[section] as T);
}
