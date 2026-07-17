import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRequestDetails, syncAllSessions } from "@veyyon/omp-stats/aggregator";
import { closeDb, getRecentRequests, initDb } from "@veyyon/omp-stats/db";
import { getSessionEntryChain } from "@veyyon/omp-stats/parser";
import type { SessionMessageEntry } from "@veyyon/omp-stats/types";
import { getSessionsDir } from "@veyyon/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-request-details-");

function messageEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
	message: unknown,
): Record<string, unknown> {
	return { type: "message", id, parentId, timestamp, message };
}

function assistantMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		responseId: `resp-${text}`,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: Date.parse("2026-06-24T10:00:00.000Z"),
		duration: 10,
		ttft: 5,
	};
}

async function writeSessionFile(fileName: string, entries: unknown[]): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp-request-details");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const header = {
		type: "session",
		version: 3,
		id: fileName.replace(/\.jsonl$/, ""),
		timestamp: new Date("2026-06-24T09:59:00.000Z").toISOString(),
		cwd: "/tmp/request-details",
	};
	const lines = [header, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();

describe("getSessionEntryChain", () => {
	it("returns the parentId ancestor chain oldest-first, ending with the requested entry", async () => {
		const sessionFile = await writeSessionFile("chain-basic.jsonl", [
			messageEntry("user-1", null, ts, { role: "user", content: "first prompt" }),
			messageEntry("asst-1", "user-1", ts, assistantMessage("first reply")),
			messageEntry("user-2", "asst-1", ts, { role: "user", content: "second prompt" }),
			messageEntry("asst-2", "user-2", ts, assistantMessage("second reply")),
			// A sibling branch that must NOT appear in asst-2's chain.
			messageEntry("user-2b", "asst-1", ts, { role: "user", content: "fork prompt" }),
		]);

		const chain = await getSessionEntryChain(sessionFile, "asst-2");
		expect(chain.map(entry => (entry as SessionMessageEntry).id)).toEqual([
			"user-1",
			"asst-1",
			"user-2",
			"asst-2",
		]);
	});

	it("caps the chain at maxEntries keeping the newest entries", async () => {
		const entries = [messageEntry("e0", null, ts, { role: "user", content: "root" })];
		for (let i = 1; i <= 9; i++) {
			entries.push(messageEntry(`e${i}`, `e${i - 1}`, ts, { role: "user", content: `m${i}` }));
		}
		const sessionFile = await writeSessionFile("chain-cap.jsonl", entries);

		const chain = await getSessionEntryChain(sessionFile, "e9", 3);
		expect(chain.map(entry => (entry as SessionMessageEntry).id)).toEqual(["e7", "e8", "e9"]);
	});

	it("survives a parentId cycle and a dangling parent without hanging", async () => {
		const sessionFile = await writeSessionFile("chain-cycle.jsonl", [
			messageEntry("a", "b", ts, { role: "user", content: "a" }),
			messageEntry("b", "a", ts, { role: "user", content: "b" }),
			messageEntry("dangling", "no-such-parent", ts, { role: "user", content: "d" }),
		]);

		const cycle = await getSessionEntryChain(sessionFile, "a");
		expect(cycle.map(entry => (entry as SessionMessageEntry).id)).toEqual(["b", "a"]);

		const dangling = await getSessionEntryChain(sessionFile, "dangling");
		expect(dangling.map(entry => (entry as SessionMessageEntry).id)).toEqual(["dangling"]);
	});

	it("returns an empty chain for a missing file or unknown entry", async () => {
		const sessionFile = await writeSessionFile("chain-missing.jsonl", [
			messageEntry("only", null, ts, { role: "user", content: "x" }),
		]);
		expect(await getSessionEntryChain(sessionFile, "nope")).toEqual([]);
		expect(await getSessionEntryChain(path.join(getSessionsDir(), "absent.jsonl"), "only")).toEqual([]);
	});
});

describe("getRequestDetails", () => {
	it("includes the parent user prompt and context ahead of the assistant response", async () => {
		await writeSessionFile("details-e2e.jsonl", [
			messageEntry("user-1", null, ts, { role: "user", content: "what is 2+2" }),
			messageEntry("asst-1", "user-1", ts, assistantMessage("4")),
		]);
		await initDb();
		await syncAllSessions();
		const request = getRecentRequests(10).find(row => row.entryId === "asst-1");
		expect(request).toBeDefined();

		const details = await getRequestDetails(request!.id!);
		expect(details).not.toBeNull();
		const ids = details!.messages.map(entry => (entry as SessionMessageEntry).id);
		expect(ids).toEqual(["user-1", "asst-1"]);
		const prompt = details!.messages[0] as SessionMessageEntry;
		expect((prompt.message as { role: string; content: string }).content).toBe("what is 2+2");
		expect((details!.output as { content: Array<{ text: string }> }).content[0]!.text).toBe("4");
		closeDb();
	});
});
