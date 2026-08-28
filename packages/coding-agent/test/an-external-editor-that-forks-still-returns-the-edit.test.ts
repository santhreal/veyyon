/**
 * WHY. `ctrl+g` opens the composer buffer in `$VISUAL`/`$EDITOR` and reads the
 * file back when the child exits. A GUI editor forks: `code file.md` hands the
 * path to an already-running window and returns 0 immediately, so the read-back
 * happened before the user had typed anything and the composer was replaced
 * with the text it already held. Nothing errored, so it looked like the
 * keybinding did nothing.
 *
 * THE CLASS THIS CLOSES. Not "code needs --wait", but "no editor this project
 * knows to fork is ever spawned without the flag that makes it block". The
 * table is the variant space and the test sweeps it, so an editor added
 * without a wait flag, or with one the resolver does not append, fails here.
 *
 * WHAT THIS DOES NOT CATCH. An editor nobody listed. A GUI editor absent from
 * the table still forks and still returns early; the table is the only thing
 * that knows, and there is no way to detect it from the binary name alone.
 */
import { describe, expect, it } from "bun:test";
import { EDITOR_WAIT_FLAGS, resolveEditorInvocation } from "../src/utils/external-editor";

describe("an editor that forks is told to block", () => {
	it("appends the wait flag for every editor known to fork", () => {
		const missing: string[] = [];
		for (const [binary, flags] of EDITOR_WAIT_FLAGS) {
			const resolved = resolveEditorInvocation(binary);
			if (!flags.every(flag => resolved.args.includes(flag))) missing.push(binary);
		}

		expect(missing).toEqual([]);
		// Non-vacuity: the sweep really had entries to check.
		expect(EDITOR_WAIT_FLAGS.size).toBeGreaterThan(10);
	});

	it("finds the editor behind an absolute path and a .exe suffix", () => {
		expect(resolveEditorInvocation("/usr/local/bin/code").args).toEqual(["--wait"]);
		expect(resolveEditorInvocation("C:\\Program\\Cursor.exe").args).toEqual(["--wait"]);
	});

	it("keeps the user's own flags and adds the wait flag beside them", () => {
		const resolved = resolveEditorInvocation("code --new-window");

		expect(resolved.command).toBe("code");
		expect(resolved.args).toEqual(["--new-window", "--wait"]);
	});

	it("does not add a second wait flag when the command line already blocks", () => {
		expect(resolveEditorInvocation("code --wait").args).toEqual(["--wait"]);
		expect(resolveEditorInvocation("code -w").args).toEqual(["-w"]);
		expect(resolveEditorInvocation("kate --block").args).toEqual(["--block"]);
	});

	it("leaves a terminal editor exactly as the user spelled it", () => {
		expect(resolveEditorInvocation("vim")).toEqual({ command: "vim", args: [] });
		expect(resolveEditorInvocation("nano -w")).toEqual({ command: "nano", args: ["-w"] });
		expect(resolveEditorInvocation("emacs -nw")).toEqual({ command: "emacs", args: ["-nw"] });
	});
});
