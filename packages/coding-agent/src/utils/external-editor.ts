import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@veyyon/utils";

export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

export const EDITOR_WAIT_FLAGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
	["code", ["--wait"]],
	["code-insiders", ["--wait"]],
	["codium", ["--wait"]],
	["vscodium", ["--wait"]],
	["cursor", ["--wait"]],
	["windsurf", ["--wait"]],
	["positron", ["--wait"]],
	["zed", ["--wait"]],
	["subl", ["--wait"]],
	["sublime_text", ["--wait"]],
	["atom", ["--wait"]],
	["gedit", ["--wait"]],
	["kate", ["--block"]],
	["mate", ["--wait"]],
	["gvim", ["--nofork"]],
	["mvim", ["--nofork"]],
	["notepad++", ["-multiInst", "-nosession"]],
]);

function editorBinaryName(command: string): string {
	const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
	return base.replace(/\.exe$/i, "").toLowerCase();
}

export function resolveEditorInvocation(editorCmd: string): { command: string; args: string[] } {
	const [command = editorCmd, ...args] = editorCmd.trim().split(/\s+/);
	const waitFlags = EDITOR_WAIT_FLAGS.get(editorBinaryName(command));
	if (!waitFlags) return { command, args };
	const alreadyWaits = args.includes("-w") || waitFlags.some(flag => args.includes(flag));
	return { command, args: alreadyWaits ? args : args.concat(waitFlags) };
}

export interface OpenInEditorOptions {
	extension?: string;
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	trimTrailingNewline?: boolean;
}

export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `veyyon-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const { command: editor, args: editorArgs } = resolveEditorInvocation(editorCmd);
		const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];

		const child = spawn(editor, editorArgs.concat([tmpFile]), { stdio, shell: process.platform === "win32" });
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		const exitCode = await promise;

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {}
	}
}
