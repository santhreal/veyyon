/**
 * Flush stdout before a hard exit.
 *
 * `process.exit` does not wait for a pipe to drain: a pipe holds at most its
 * kernel buffer (128 KiB on Linux) of what `process.stdout.write` accepted, and
 * whatever is still queued in the process is dropped. A one-shot RPC client that
 * sends `get_state` and closes stdin received the response cut at 131072 bytes
 * for that reason.
 *
 * Under Bun, `process.stdout` writes through a `FileSink`, and a write callback
 * fires as soon as that chunk is accepted, not when the sink's queue is empty:
 * an empty write with a callback resolves at once while up to a megabyte of an
 * earlier frame is still buffered in the process. The sink's `flush()` is the
 * primitive that waits for the queue; there is no portable spelling of it, so
 * this is the one place it is reached. Bun stores the sink on the stream under
 * a symbol whose description is `kWriteStreamFastPath`; when it is absent (Node,
 * a replaced stdout) the Node contract applies and the callback path is used.
 */
interface FlushableSink {
	flush(): number | Promise<number>;
}

function isFlushableSink(value: unknown): value is FlushableSink {
	return typeof value === "object" && value !== null && "flush" in value && typeof value.flush === "function";
}

function stdoutSink(): FlushableSink | undefined {
	const stream: object = process.stdout;
	const key = Object.getOwnPropertySymbols(stream).find(symbol => symbol.description === "kWriteStreamFastPath");
	if (!key) return undefined;
	const sink: unknown = Reflect.get(stream, key);
	return isFlushableSink(sink) ? sink : undefined;
}

export async function awaitStdoutDrain(): Promise<void> {
	const sink = stdoutSink();
	if (sink) {
		await sink.flush();
		return;
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	process.stdout.write("", error => {
		if (error) reject(error);
		else resolve();
	});
	return promise;
}

/** Drain stdout, then exit with `code`. Never returns. */
export async function exitAfterStdoutDrain(code: number): Promise<never> {
	await awaitStdoutDrain();
	process.exit(code);
}
