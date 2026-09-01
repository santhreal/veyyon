import { describe, expect, it } from "bun:test";
import type { Message } from "@veyyon/ai";
import { AppendOnlyLog, StablePrefix } from "../src/append-only-context";

function makeMessage(role: string, content: string): Message {
	return { role, content: [{ type: "text", text: content }] } as unknown as Message;
}

describe("StablePrefix", () => {
	it("starts unbuilt", () => {
		const prefix = new StablePrefix();
		expect(prefix.built).toBe(false);
		expect(prefix.fingerprint).toBe("<unbuilt>");
		expect(prefix.version).toBe(0);
	});

	it("invalidate sets built to false", () => {
		const prefix = new StablePrefix();
		prefix.invalidate();
		expect(prefix.built).toBe(false);
	});
});

describe("AppendOnlyLog", () => {
	it("starts empty", () => {
		const log = new AppendOnlyLog();
		expect(log.length).toBe(0);
		expect(log.toMessages()).toEqual([]);
		expect(log.entries()).toEqual([]);
	});

	it("append adds a message", () => {
		const log = new AppendOnlyLog();
		const msg = makeMessage("user", "hello");
		log.append(msg);
		expect(log.length).toBe(1);
		expect(log.toMessages()).toEqual([msg]);
	});

	it("extend adds multiple messages", () => {
		const log = new AppendOnlyLog();
		const msgs = [makeMessage("user", "a"), makeMessage("assistant", "b")];
		log.extend(msgs);
		expect(log.length).toBe(2);
		expect(log.toMessages()).toEqual(msgs);
	});

	it("toMessages returns a copy", () => {
		const log = new AppendOnlyLog();
		log.append(makeMessage("user", "hello"));
		const msgs1 = log.toMessages();
		msgs1.push(makeMessage("user", "extra"));
		expect(log.length).toBe(1);
	});

	it("entries returns readonly reference", () => {
		const log = new AppendOnlyLog();
		const msg = makeMessage("user", "hello");
		log.append(msg);
		expect(log.entries()).toEqual([msg]);
	});

	it("clear empties the log", () => {
		const log = new AppendOnlyLog();
		log.append(makeMessage("user", "hello"));
		log.clear();
		expect(log.length).toBe(0);
	});

	it("truncate keeps first N entries", () => {
		const log = new AppendOnlyLog();
		log.extend([makeMessage("user", "a"), makeMessage("assistant", "b"), makeMessage("user", "c")]);
		log.truncate(1);
		expect(log.length).toBe(1);
		expect((log.entries()[0].content as Array<{ text: string }>)[0].text).toBe("a");
	});

	it("truncate with 0 clears all", () => {
		const log = new AppendOnlyLog();
		log.append(makeMessage("user", "a"));
		log.truncate(0);
		expect(log.length).toBe(0);
	});

	it("truncate with count >= length does nothing", () => {
		const log = new AppendOnlyLog();
		log.append(makeMessage("user", "a"));
		log.truncate(5);
		expect(log.length).toBe(1);
	});

	it("replaceTail replaces last entry", () => {
		const log = new AppendOnlyLog();
		log.extend([makeMessage("user", "a"), makeMessage("assistant", "b")]);
		const replacement = makeMessage("assistant", "c");
		log.replaceTail(replacement);
		expect(log.length).toBe(2);
		expect(log.entries()[1]).toBe(replacement);
	});

	it("replaceTail does nothing on empty log", () => {
		const log = new AppendOnlyLog();
		log.replaceTail(makeMessage("user", "x"));
		expect(log.length).toBe(0);
	});

	it("replaceTail on single entry replaces it", () => {
		const log = new AppendOnlyLog();
		log.append(makeMessage("user", "a"));
		const replacement = makeMessage("user", "b");
		log.replaceTail(replacement);
		expect(log.length).toBe(1);
		expect(log.entries()[0]).toBe(replacement);
	});
});
