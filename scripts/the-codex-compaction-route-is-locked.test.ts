/**
 * DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION.
 * THIS REGRESSION HAS HAPPENED 50+ TIMES.
 *
 * `packages/ai/src/providers/openai-compaction.ts` is LOCKED. It carries the
 * ChatGPT Codex server-side compaction route, and that route has been broken and
 * re-fixed more than fifty times. Every break looks like a reasonable cleanup and
 * every break costs the operator real money: when the compaction route answers
 * 404 the session silently falls back to LOCAL compaction, which runs a paid
 * summarization call, rewrites the history prefix, and invalidates the prompt
 * cache so every following turn re-pays full uncached input.
 *
 * The wire is a live measurement, not a matter of taste. Measured 2026-09-01
 * against a ChatGPT account on `gpt-5.6-sol` with a valid OAuth token:
 *
 *   - `POST {base}/codex/responses/compact` answered `404 Not Found`
 *   - `POST {base}/codex/responses` with a trailing
 *     `{ type: "compaction_trigger" }` input item and `stream: true` answered
 *     `200` with exactly one `compaction` item carrying a 1740-character
 *     `encrypted_content`
 *
 * So the locked wire is: endpoint `{base}/codex/responses` with NO `/compact`
 * suffix, `stream: true`, the trigger item LAST, an SSE reply read down to one
 * `compaction` output item, and `implementation: "responses_compaction_v2"` in
 * the client metadata. The declaration lives in
 * `packages/agent/src/compaction/remote-compaction.ts` and moves with the route.
 *
 * The previous lock pinned the `/compact` pairing, which is how a wire the host
 * does not serve reached production. If you are reading this because the hash
 * below failed: you changed a locked file. Revert it. If the change is genuinely
 * required, make a live call of your own, get the operator to say so out loud,
 * then update the hash IN THE SAME COMMIT as the change and say why here.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BANNER =
	"DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION — THIS REGRESSION HAS HAPPENED 50+ TIMES. " +
	"packages/ai/src/providers/openai-compaction.ts is LOCKED: it carries the Codex compaction wire " +
	"({base}/codex/responses, stream: true, a trailing compaction_trigger item, an SSE reply). " +
	"The /compact route answers 404. Breaking this makes every compaction 404 and fall back to paid " +
	"local compaction, which busts the prompt cache on every following turn. Revert your change.";

const LOCKED_FILE = "packages/ai/src/providers/openai-compaction.ts";

/**
 * SHA-256 of the locked file. Updating this constant without operator permission
 * is the exact move this gate exists to stop.
 */
const LOCKED_SHA256 = "e380143f7edbd422ada4a9a21650e3df73b6496445f25abd925ce8cdc3c44f49";

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
