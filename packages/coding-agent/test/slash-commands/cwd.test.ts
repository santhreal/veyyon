import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@veyyon/utils";

// WHY THIS SUITE EXISTS (BACKLOG DOG-CWD-HINT)
// --------------------------------------------
// A user (and a Gemini dogfood agent) could not tell that `/cwd` is ephemeral
// (session-only) and that a per-profile DEFAULT working directory is the
// `session.workdir` setting, so `set_cwd`/`/cwd` felt like they "did nothing that
// stuck". The command output now states the change is session-scoped/ephemeral and
// names the `session.workdir` remedy, and a failing relative path names the base it
// resolved against. These tests lock that hint text in so it cannot silently drop.

function createRuntime(current: string) {
	const showStatus = vi.fn();
	const setText = vi.fn();
	const setCwd = vi.fn(async (path: string) => path);
	return {
		showStatus,
		setCwd,
		runtime: {
			ctx: {
				collabGuest: false,
				showStatus,
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				session: {
					isStreaming: false,
					setCwd,
					refreshSshTool: vi.fn(async () => {}),
				},
				sessionManager: { getCwd: () => current },
				settings: {},
				refreshSlashCommandState: vi.fn(async () => {}),
			} as unknown as InteractiveModeContext,
		},
	};
}

function lastStatus(showStatus: ReturnType<typeof vi.fn>): string {
	const calls = showStatus.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return String(calls[calls.length - 1][0]);
}

describe("/cwd slash command ephemeral hint", () => {
	it("bare /cwd prints the cwd and the ephemeral + session.workdir hint", async () => {
		using dir = TempDir.createSync("@veyyon-cwd-bare-");
		const h = createRuntime(dir.path());

		const handled = await executeBuiltinSlashCommand("/cwd", h.runtime);

		expect(handled).toBe(true);
		const out = lastStatus(h.showStatus);
		expect(out).toContain(dir.path());
		expect(out).toContain("ephemeral");
		expect(out).toContain("session.workdir");
	});

	it("/cwd <existing dir> re-roots and appends the session.workdir hint", async () => {
		using from = TempDir.createSync("@veyyon-cwd-from-");
		using to = TempDir.createSync("@veyyon-cwd-to-");
		const h = createRuntime(from.path());

		const handled = await executeBuiltinSlashCommand(`/cwd ${to.path()}`, h.runtime);

		expect(handled).toBe(true);
		expect(h.setCwd).toHaveBeenCalledWith(to.path(), { validate: true });
		const out = lastStatus(h.showStatus);
		expect(out).toContain("cwd set:");
		expect(out).toContain("session-scoped and ephemeral");
		expect(out).toContain("session.workdir");
	});

	it("a failing relative /cwd names the session cwd it resolved against", async () => {
		using dir = TempDir.createSync("@veyyon-cwd-rel-");
		const h = createRuntime(dir.path());

		// A relative arg that does not exist under the session cwd: the error must
		// explain that relative paths resolve against the session cwd, not the OS cwd.
		const handled = await executeBuiltinSlashCommand("/cwd no-such-subdir-xyz", h.runtime);

		expect(handled).toBe(true);
		expect(h.setCwd).not.toHaveBeenCalled();
		const out = lastStatus(h.showStatus);
		expect(out).toContain("Directory does not exist");
		expect(out).toContain("relative paths resolve against the current session cwd");
		expect(out).toContain(dir.path());
	});
});
