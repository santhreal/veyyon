import { stripAnsi, stripAnsiExceptSgr } from "./strip-ansi";

/**
 * Reduce text to one line a terminal draws as text: strips 7-bit and 8-bit ANSI escape sequences,
 * maps the remaining C0 and C1 controls to spaces, collapses runs of spaces, and trims the ends.
 *
 * A caller passes text it did not author -- a branch name, a model id, an account label, a goal
 * objective -- into a surface that is one line wide and has no escape of its own. An escape left in
 * it styles or moves the rest of the surface, a tab opens a hole, and a newline puts half the value
 * where the next field belongs.
 *
 * The escape grammar is owned here rather than delegated to the runtime, so the result is the same
 * on every platform and runtime version. It is text-only and names no host, which is why it sits in
 * `@veyyon/utils` rather than beside the terminal status line that first needed it.
 */
export function sanitizeStatusText(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * The same sanitizer for text a caller is allowed to style: hook status text
 * (`ctx.ui.setStatus`), whose contract admits theme colours. SGR sequences
 * survive; every other escape and control byte is stripped or spaced as above.
 */
export function sanitizeStyledStatusText(text: string): string {
	return stripAnsiExceptSgr(text)
		.replace(/[\u0000-\u001a\u001c-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
