import { describe, expect, it, vi } from "bun:test";
import type { CompactOptions } from "@veyyon/coding-agent/extensibility/extensions/types";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { CompactMode } from "@veyyon/coding-agent/session/compact-modes";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

function acpRuntime() {
	const compact = vi.fn(async (_instructions?: string, _options?: CompactOptions) => {});
	const getContextUsage = vi.fn(() => undefined);
	const output = vi.fn();
	const runtime = { session: { compact, getContextUsage }, output } as unknown as SlashCommandRuntime;
	return { compact, output, runtime };
}

function tuiRuntime() {
	const handleCompactCommand = vi.fn(async () => "ok" as const);
	const setText = vi.fn();
	const showWarning = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			handleCompactCommand,
			showWarning,
		} as unknown as InteractiveModeContext,
	};
	return { handleCompactCommand, setText, showWarning, runtime };
}

describe("/compact dispatch (ACP)", () => {
	it("compacts with the configured strategy and no mode for a bare invocation", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact", h.runtime);
		expect(h.compact).toHaveBeenCalledWith(undefined, undefined);
	});

	it("threads each mode subcommand into compact()", async () => {
		for (const mode of ["summary", "handoff"] as const satisfies readonly CompactMode[]) {
			const h = acpRuntime();
			await executeAcpBuiltinSlashCommand(`/compact ${mode}`, h.runtime);
			expect(h.compact).toHaveBeenCalledWith(undefined, { mode });
		}
	});

	it("splits a mode from its focus instructions", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact summary focus on the parser", h.runtime);
		expect(h.compact).toHaveBeenCalledWith("focus on the parser", { mode: "summary" });
	});

	it("treats a non-mode argument as plain focus instructions (backward compatible)", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact summarize the auth flow", h.runtime);
		expect(h.compact).toHaveBeenCalledWith("summarize the auth flow", undefined);
	});

	it("advertises the mode subcommands and input hint to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "compact");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[summary|handoff] [focus]");
	});
});

/**
 * The retired-name notice has to reach the user on BOTH surfaces.
 *
 * The parser producing a notice is worth nothing if a caller drops it: `/compact
 * soft` would still compact with the configured strategy and report success, which
 * is the silent fallback the notice exists to remove. ACP and the TUI have
 * separate dispatch paths and separate ways of speaking to the user, so each is
 * checked, and each is checked to still perform the compaction — a notice that
 * came at the cost of refusing the command would be a regression for anyone with
 * the old name in a script.
 */
describe("/compact with a retired mode name", () => {
	it("tells an ACP client the name is retired, and still compacts", async () => {
		const h = acpRuntime();

		await executeAcpBuiltinSlashCommand("/compact soft keep the auth bits", h.runtime);

		const said = h.output.mock.calls.map(call => String(call[0])).join("\n");
		expect(said).toContain("`soft` is no longer a compaction mode");
		expect(said).toContain("/compact summary");
		// Passed through as focus text with no mode, exactly as typed.
		expect(h.compact).toHaveBeenCalledWith("soft keep the auth bits", undefined);
	});

	/** Said BEFORE the outcome line, so it reads as a caveat on this compaction
	 * rather than as advice about the next one. */
	it("says it before reporting the compaction", async () => {
		const h = acpRuntime();

		await executeAcpBuiltinSlashCommand("/compact remote", h.runtime);

		const lines = h.output.mock.calls.map(call => String(call[0]));
		const noticeIndex = lines.findIndex(line => line.includes("no longer a compaction mode"));
		const doneIndex = lines.findIndex(line => line.includes("Compaction complete"));
		expect(noticeIndex).toBeGreaterThanOrEqual(0);
		expect(doneIndex).toBeGreaterThan(noticeIndex);
	});

	it("warns in the TUI, and still compacts", async () => {
		const h = tuiRuntime();

		await executeBuiltinSlashCommand("/compact SOFT", h.runtime);

		expect(h.showWarning.mock.calls.map(call => String(call[0])).join("\n")).toContain("no longer a compaction mode");
		expect(h.handleCompactCommand).toHaveBeenCalledWith("SOFT", undefined);
	});

	it("stays quiet for a live mode on both surfaces", async () => {
		const acp = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact summary", acp.runtime);
		expect(acp.output.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("no longer");

		const tui = tuiRuntime();
		await executeBuiltinSlashCommand("/compact handoff", tui.runtime);
		expect(tui.showWarning).not.toHaveBeenCalled();
	});
});

describe("/compact dispatch (TUI)", () => {
	it("routes mode + focus to handleCompactCommand and clears the editor", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/compact handoff fix the bug", h.runtime);
		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.handleCompactCommand).toHaveBeenCalledWith("fix the bug", "handoff");
	});

	it("passes no mode for a bare /compact", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/compact", h.runtime);
		expect(h.handleCompactCommand).toHaveBeenCalledWith(undefined, undefined);
	});
});
