import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import {
	getLatestTodoPhasesFromEntries,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@veyyon/coding-agent/tools/todo";

/**
 * getLatestTodoPhasesFromEntries reconstructs the current todo list by scanning the session entries
 * BACKWARD for the most recent authoritative source: a user_todo_edit custom entry (a manual edit) or
 * a successful `todo` toolResult. It had no direct test. The contract that matters: the scan returns
 * the LATEST such entry (so a stale earlier list never wins), it skips an ERRORED todo result (which
 * carries no valid phases), and it returns a deep CLONE so a caller mutating the result cannot corrupt
 * the persisted entry. A regression in any of these shows the user the wrong or a corrupted todo list.
 */

const phases = (name: string): TodoPhase[] => [{ name, tasks: [{ content: "t", status: "pending" }] }];

const todoResult = (p: TodoPhase[], isError = false): SessionEntry =>
	({
		type: "message",
		id: "r",
		parentId: null,
		timestamp: "t",
		message: { role: "toolResult", toolName: "todo", isError, details: { phases: p } },
	}) as unknown as SessionEntry;

const userTodoEdit = (p: TodoPhase[]): SessionEntry =>
	({
		type: "custom",
		id: "c",
		parentId: null,
		timestamp: "t",
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		data: { phases: p },
	}) as unknown as SessionEntry;

const userMessage: SessionEntry = {
	type: "message",
	id: "u",
	parentId: null,
	timestamp: "t",
	message: { role: "user", content: "hi", timestamp: 1 },
} as unknown as SessionEntry;

describe("getLatestTodoPhasesFromEntries", () => {
	it("returns an empty list when there are no entries or none carry todo phases", () => {
		expect(getLatestTodoPhasesFromEntries([])).toEqual([]);
		expect(getLatestTodoPhasesFromEntries([userMessage])).toEqual([]);
	});

	it("reads phases off a successful todo toolResult", () => {
		expect(getLatestTodoPhasesFromEntries([todoResult(phases("A"))])).toEqual(phases("A"));
	});

	it("returns the latest todo source, never a stale earlier one", () => {
		expect(getLatestTodoPhasesFromEntries([todoResult(phases("OLD")), todoResult(phases("NEW"))])).toEqual(
			phases("NEW"),
		);
	});

	it("prefers a later manual user_todo_edit over an earlier tool result", () => {
		expect(getLatestTodoPhasesFromEntries([todoResult(phases("OLD")), userTodoEdit(phases("EDIT"))])).toEqual(
			phases("EDIT"),
		);
	});

	it("skips an errored todo result and keeps the last good one", () => {
		expect(getLatestTodoPhasesFromEntries([todoResult(phases("GOOD")), todoResult(phases("BAD"), true)])).toEqual(
			phases("GOOD"),
		);
	});

	it("returns a deep clone so mutating the result cannot corrupt the source entry", () => {
		const source = phases("Z");
		const entry = todoResult(source);
		const result = getLatestTodoPhasesFromEntries([entry]);
		result[0].name = "MUTATED";
		expect(source[0].name).toBe("Z");
	});
});
