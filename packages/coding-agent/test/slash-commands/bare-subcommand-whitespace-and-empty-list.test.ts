/**
 * `bareInvocationShowsSubcommands` is the one predicate both TUI and ACP use
 * to decide whether `/cmd` is a picker/list or a silent default subcommand.
 *
 * Existing `bare-command-opens-a-picker.test.ts` drives the TUI picker with
 * real commands. It never unit-tests the leaf: trim of `" "`, `bareAction:
 * "distinct"`, empty `subcommands`, and `formatSubcommandList` on a zero-length
 * table (`Math.max(...[])` is `-Infinity`).
 *
 * A command that declares subcommands must not run a default just because the
 * operator typed a space. A command that claimed `bareAction: "distinct"` must
 * still run on `""`.
 */
import { describe, expect, it } from "bun:test";
import {
	bareInvocationShowsSubcommands,
	formatSubcommandList,
} from "@veyyon/coding-agent/slash-commands/bare-subcommand";
import type { SubcommandDef } from "@veyyon/coding-agent/slash-commands/types";

const subs: SubcommandDef[] = [
	{ name: "status", description: "Show status" },
	{ name: "login", description: "Sign in", usage: "<provider>" },
];

describe("bareInvocationShowsSubcommands trims args so a space is still bare", () => {
	it("shows the list for an empty args string", () => {
		expect(bareInvocationShowsSubcommands({ subcommands: subs }, "")).toBe(true);
	});

	it("shows the list for args that are only spaces", () => {
		expect(bareInvocationShowsSubcommands({ subcommands: subs }, "   ")).toBe(true);
	});

	it("shows the list for a tab-only args string", () => {
		expect(bareInvocationShowsSubcommands({ subcommands: subs }, "\t")).toBe(true);
	});

	it("does not show the list when a real verb is present", () => {
		expect(bareInvocationShowsSubcommands({ subcommands: subs }, "status")).toBe(false);
	});

	it("does not show the list when the verb is padded but non-empty after trim", () => {
		expect(bareInvocationShowsSubcommands({ subcommands: subs }, "  status  ")).toBe(false);
	});
});

describe("bareAction distinct is the exception, even when subcommands exist", () => {
	it("does not show the list for a distinct bare form with empty args", () => {
		expect(
			bareInvocationShowsSubcommands({ subcommands: subs, bareAction: "distinct" }, ""),
		).toBe(false);
	});

	it("does not show the list for a distinct bare form with whitespace args", () => {
		expect(
			bareInvocationShowsSubcommands({ subcommands: subs, bareAction: "distinct" }, "  "),
		).toBe(false);
	});

	it("still does not show the list when distinct and a verb is present (handler sees the verb)", () => {
		expect(
			bareInvocationShowsSubcommands({ subcommands: subs, bareAction: "distinct" }, "status"),
		).toBe(false);
	});
});

describe("no subcommands means this is not a list, even when args are empty", () => {
	it("returns false when subcommands is undefined", () => {
		expect(bareInvocationShowsSubcommands({}, "")).toBe(false);
	});

	it("returns false when subcommands is an empty array", () => {
		expect(bareInvocationShowsSubcommands({ subcommands: [] }, "")).toBe(false);
	});
});

describe("formatSubcommandList must not explode on an empty table", () => {
	it("does not throw when there are zero subcommands", () => {
		expect(() => formatSubcommandList("account", [])).not.toThrow();
	});

	it("names the command and the count 0 rather than printing -Infinity padding", () => {
		const text = formatSubcommandList("account", []);
		expect(text).toContain("/account has 0 subcommands:");
		expect(text).not.toContain("Infinity");
		expect(text).not.toContain("NaN");
	});

	it("aligns names to the longest sibling, and still prints usage", () => {
		const text = formatSubcommandList("account", subs);
		expect(text).toContain("/account has 2 subcommands:");
		expect(text).toContain("/account status");
		expect(text).toContain("/account login  <provider>");
		expect(text).toContain("Show status");
		expect(text).toContain("Sign in");
	});

	it("does not drop a description that is empty — the column still exists", () => {
		const text = formatSubcommandList("x", [{ name: "a", description: "" }]);
		expect(text).toContain("/x a");
	});
});
