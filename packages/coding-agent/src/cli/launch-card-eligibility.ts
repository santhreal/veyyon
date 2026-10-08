import type { Args } from "./args";

/**
 * True only for a bare interactive launch that lands on the home screen.
 *
 * Read from argv alone, before settings exist, because the whole point is to
 * decide without loading anything. A run that exits early (`--version`,
 * `--export`), prints (`--print`, a piped prompt) or speaks a protocol never
 * paints a card, and must not pay for settings, a theme or the first-frame
 * renderer here. Piped stdin needs no separate test: `autoPrint` requires
 * input on stdin, and stdin is a TTY on this path.
 *
 * It is its own module so `commands/launch.ts` asks this before importing
 * `./launch-card`, whose first-frame paint imports the terminal renderer.
 */
export function shouldPrepaintLaunchCard(parsed: Args): boolean {
	if (parsed.version || parsed.export !== undefined) return false;
	if (parsed.print || parsed.mode !== undefined) return false;
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
