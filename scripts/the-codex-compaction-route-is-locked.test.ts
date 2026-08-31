/**
 * DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION.
 * THIS REGRESSION HAS HAPPENED 50+ TIMES.
 *
 * `packages/ai/src/providers/openai-compaction.ts` is LOCKED. It carries the
 * ChatGPT Codex server-side compaction route, and that route has been broken and
 * re-fixed more than fifty times. Every break looks like a reasonable cleanup and
 * every break costs the operator real money: when the compact route answers 404
 * the session silently falls back to LOCAL compaction, which runs a paid
 * summarization call, rewrites the history prefix, and invalidates the prompt
 * cache so every following turn re-pays full uncached input.
 *
 * The wire is oh-my-pi's (`can1357/oh-my-pi`,
 * `packages/agent/src/compaction/openai.ts`, `resolveOpenAiCodexCompactEndpoint`)
 * and it is not a matter of taste:
 *
 *   - endpoint `{base}/codex/responses/compact` — a base already ending in
 *     `/codex` takes `/responses/compact`, anything else takes
 *     `/codex/responses/compact`
 *   - ONE JSON document in reply, not a stream
 *   - NO `compaction_trigger` input item, NO `stream: true`
 *
 * The plain turn route with a trigger item answers 404 on this host. If you are
 * reading this because the hash below failed: you changed a locked file. Revert
 * it. If the change is genuinely required, get the operator to say so out loud,
 * then update the hash IN THE SAME COMMIT as the change and say why here.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BANNER =
	"DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION — THIS REGRESSION HAS HAPPENED 50+ TIMES. " +
	"packages/ai/src/providers/openai-compaction.ts is LOCKED: it carries the Codex compact route " +
	"({base}/codex/responses/compact, one JSON document, no compaction_trigger, no stream). " +
	"Breaking it makes every compaction 404 and fall back to paid local compaction, which busts the " +
	"prompt cache on every following turn. Revert your change.";

const LOCKED_FILE = "packages/ai/src/providers/openai-compaction.ts";

/**
 * SHA-256 of the locked file. Updating this constant without operator permission
 * is the exact move this gate exists to stop.
 */
const LOCKED_SHA256 = "530bcf8558d111b938259048cf02e2a2eda21f14e0299ffc50ed4b8bdde0de1d";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("the codex compaction route is locked", () => {
	it("has not been modified", async () => {
		const contents = await readFile(`${repoRoot}${LOCKED_FILE}`);
		const actual = createHash("sha256").update(contents).digest("hex");
		if (actual !== LOCKED_SHA256) {
			throw new Error(
				`${BANNER}\n\n  expected sha256 ${LOCKED_SHA256}\n  actual   sha256 ${actual}\n  file     ${LOCKED_FILE}`,
			);
		}
		expect(actual).toBe(LOCKED_SHA256);
	});
});
