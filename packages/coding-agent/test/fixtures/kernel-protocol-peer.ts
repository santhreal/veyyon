import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

const expectedExit =
	process.argv[2] === "empty"
		? ""
		: process.argv[2] === "custom"
			? '{"type":"exit","custom":true}'
			: '{"type":"exit"}';
process.exitCode = 27;
let interruptedId: string | undefined;
process.on("SIGINT", () => {
	void setTimeout(100).then(() => {
		process.stdout.write(`${JSON.stringify({ type: "done", id: interruptedId, status: "ok", cancelled: true })}\n`);
	});
});
for await (const line of createInterface({ input: process.stdin })) {
	if (line === expectedExit) {
		await setTimeout(100);
		process.exitCode = 0;
		break;
	}
	const request = JSON.parse(line) as { id: string; type?: string; code?: string };
	if (request.type === "exit") break;
	if (request.code === "interrupt") {
		interruptedId = request.id;
		process.stdout.write(`${JSON.stringify({ type: "stdout", id: request.id, data: "ready" })}\n`);
		continue;
	}
	process.stdout.write(`${JSON.stringify({ type: "stdout", id: request.id, data: line })}\n`);
	process.stdout.write(`${JSON.stringify({ type: "done", id: request.id, status: "ok" })}\n`);
}
