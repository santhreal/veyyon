/**
 * Resolve a filesystem-backed internal URL to a path, synchronously.
 *
 * This lives with the protocols it resolves rather than with the OSC 8 writer
 * that was its first caller. `tui/hyperlink.ts` owns escape sequences and needs
 * nothing but the terminal and a setting; this needs the local and memory
 * protocol handlers, which reach the session's project registry. Keeping both in
 * one file put that registry in the import graph of everything that draws a
 * link, and the launch shell draws links.
 */

import { LocalProtocolHandler, resolveLocalUrlToPath } from "./local-protocol";
import { memoryRootsFromRegistry, resolveMemoryUrlToPath } from "./memory-protocol";
import { parseInternalUrl } from "./parse";

/**
 * Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`,
 * `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined`
 * for inputs that aren't fs-backed, aren't resolvable in the current session
 * registry, or fail to parse.
 *
 * Used by renderers to wrap fs-backed internal URLs in OSC 8 hyperlinks even
 * when the resolved path isn't yet available from tool result details (e.g.
 * during the call/streaming phase before a result lands).
 *
 * Async-resolved schemes (`artifact://`, `agent://`, `skill://`, `rule://`,
 * `veyyon://`) are not handled here — those rely on `details.resolvedPath` set
 * by the read tool's router resolution.
 */
export function tryResolveInternalUrlSync(input: string): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
		if (input.startsWith("memory://")) {
			const url = parseInternalUrl(input);
			const roots = memoryRootsFromRegistry();
			// Exactly one project, or no link. Trying roots in order and returning
			// the first that parses offered to open another project's memory file
			// under this conversation's link, and `resolveMemoryUrlToPath` is a pure
			// path join, so the FIRST root always "succeeds" and the loop never
			// reached a second. Two conversations in one project share a root and
			// dedupe to one, so the ordinary case still links.
			const only = roots.length === 1 ? roots[0] : undefined;
			if (!only) return undefined;
			return resolveMemoryUrlToPath(url, only);
		}
	} catch {
		// Hyperlink targets come from rendered text, including text a model wrote, so a URL this cannot map to
		// a local path is ordinary. Undefined means "not a link this terminal should offer to open", which is
		// the safe direction: the alternative is offering to open a path that was guessed.
		return undefined;
	}
	return undefined;
}
