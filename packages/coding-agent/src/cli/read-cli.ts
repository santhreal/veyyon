/**
 * Read CLI command handler.
 *
 * Handles `veyyon read` — invokes the `read` agent tool against a path/URL and
 * prints the resulting content blocks exactly as the model would receive them
 * (including truncation/limit notices appended by the meta-notice wrapper).
 */
import { getProjectDir } from "@veyyon/utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { ReadTool } from "../tools/read";
import { renderError } from "../tools/tool-errors";

export interface ReadCommandArgs {
	path: string;
}

export async function runReadCommand(cmd: ReadCommandArgs): Promise<void> {
	if (!cmd.path) {
		process.stderr.write(chalk.red("error: path is required\n"));
		process.exit(1);
	}

	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};

	const tool = wrapToolWithMetaNotice(new ReadTool(session));

	try {
		const result = await tool.execute("veyyon-read", { path: cmd.path });

		for (const block of result.content) {
			if (block.type === "text") {
				process.stdout.write(block.text);
				if (!block.text.endsWith("\n")) process.stdout.write("\n");
			} else if (block.type === "image") {
				const decodedBytes = Buffer.from(block.data, "base64").byteLength;
				process.stdout.write(
					chalk.dim(`[image content: ${block.mimeType}, ${decodedBytes} bytes base64-decoded]\n`),
				);
			}
		}

		// The tool leaves a binary/failed-conversion refusal as a non-isError
		// result so the agent keeps the `:raw` hint without retrying in a loop.
		// The CLI has no such loop, so report the refusal honestly: the read did
		// not deliver the file's content, so exit non-zero (a missing path already
		// exits 1). The bracketed notice above still explains why and how to retry.
		const details = result.details as { contentUnavailable?: { reason: string } } | undefined;
		if (details?.contentUnavailable) {
			process.exitCode = 1;
		}
	} catch (err) {
		process.stderr.write(`${chalk.red(renderError(err))}\n`);
		process.exit(1);
	}
}
