/**
 * Trace controller: normalized trace inspection across benchmark artifacts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerContext } from "../context";

/** Trace files can be runaway-huge; the viewer only shows a tail anyway. */
const TRACE_READ_CAP_BYTES = 32 * 1024 * 1024;

/** Last `cap` bytes of a file as text, dropping a leading partial line when truncated. */
function readTextTail(file: string, cap: number): string {
	const size = fs.statSync(file).size;
	if (size <= cap) return fs.readFileSync(file, "utf8");
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(cap);
		const read = fs.readSync(fd, buf, 0, cap, size - cap);
		const text = buf.subarray(0, read).toString("utf8");
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(nl + 1);
	} finally {
		fs.closeSync(fd);
	}
}

export function getTraceDetailController(ctx: ServerContext, url: URL, params: Record<string, string>): Response {
	const jobName = params.name;
	const traceName = params.trace;
	const tail = Number(url.searchParams.get("tail") ?? "120");
	const raw = url.searchParams.get("raw") === "1";

	const trace = ctx.store.listTraces(jobName).find(item => item.name === traceName);
	if (!trace?.tracePath) return Response.json({ error: "trace not found" }, { status: 404 });
	const jobDir = path.join(ctx.jobsDir, jobName);
	const n = Number.isSafeInteger(tail) && tail > 0 ? Math.min(tail, 2000) : 120;

	if (trace.tracePath.startsWith("record:")) {
		const lineNumber = Number(trace.tracePath.slice("record:".length));
		const line = fs.readFileSync(path.join(jobDir, "records.jsonl"), "utf8").split("\n")[lineNumber - 1];
		if (!line) return Response.json({ error: "trace not found" }, { status: 404 });
		if (raw) return new Response(line, { headers: { "content-type": "application/json" } });
		const record = JSON.parse(line) as Record<string, unknown>;
		return Response.json({
			jobName,
			trace: traceName,
			entries: [
				{ kind: "question", text: String(record.q ?? "") },
				{ kind: "answer", model: ctx.store.getRun(jobName)?.models ?? "", text: String(record.answer ?? "") },
				{ kind: "reference", text: JSON.stringify(record.golds ?? []) },
			],
			totalEvents: 3,
		});
	}

	const file = path.resolve(jobDir, trace.tracePath);
	if (!file.startsWith(`${path.resolve(jobDir)}${path.sep}`) || !fs.existsSync(file)) {
		return Response.json({ error: "trace not found" }, { status: 404 });
	}
	const text = readTextTail(file, TRACE_READ_CAP_BYTES);
	if (!file.endsWith(".txt")) {
		if (raw) return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
		return Response.json({
			jobName,
			trace: traceName,
			entries: [{ kind: "conversation", text }],
			totalEvents: 1,
		});
	}
	const lines = text.split("\n").filter(Boolean);
	if (raw) {
		return new Response(lines.slice(-n).join("\n"), {
			headers: { "content-type": "application/x-ndjson" },
		});
	}
	const entries: Array<Record<string, unknown>> = [];
	for (const line of lines) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type === "message_end") {
			const message = event.message as Record<string, unknown> | undefined;
			if (!message) continue;
			const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
			const body = content
				.filter(block => block.type === "text")
				.map(block => String(block.text ?? ""))
				.join("\n");
			if (message.role === "assistant") {
				const tools = content.filter(block => block.type === "toolCall").map(block => String(block.name ?? "?"));
				entries.push({ kind: "assistant", model: message.model ?? "", text: body, tools });
			} else if (message.role === "toolResult") {
				entries.push({
					kind: "toolResult",
					tool: message.toolName ?? "?",
					isError: message.isError === true,
					text: body.length > 1600 ? `${body.slice(0, 1600)}…` : body,
				});
			}
		} else if (event.type === "notice") {
			entries.push({ kind: "notice", text: event.message ?? "" });
		}
	}
	return Response.json({ jobName, trace: traceName, entries: entries.slice(-n), totalEvents: lines.length });
}
