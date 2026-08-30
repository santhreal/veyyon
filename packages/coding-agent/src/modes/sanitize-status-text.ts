import { stripAnsi } from "@veyyon/utils/strip-ansi";

/**
 * Sanitize text for display in a single-line status indicator. Strips all
 * 7-bit and 8-bit ANSI escape sequences via `@veyyon/utils`, maps remaining
 * C0 and C1 control characters to spaces, collapses consecutive spaces into a
 * single space, and trims leading and trailing whitespace.
 *
 * The escape grammar is owned directly rather than delegated to the runtime
 * environment to ensure consistent stripping across platforms and runtime
 * versions.
 *
 * It sits in its own module because the launch card's status row needs it and
 * `modes/shared.ts` costs 248 modules to reach; this one costs one.
 * `modes/shared.ts` re-exports it, so every existing caller is unchanged.
 */
export function sanitizeStatusText(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
