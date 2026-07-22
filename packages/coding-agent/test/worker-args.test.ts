import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	JS_EVAL_PROCESS_ARG,
	JS_EVAL_WORKER_ARG,
	MNEMOPI_EMBED_WORKER_ARG,
	STATS_SYNC_WORKER_ARG,
	STT_WORKER_ARG,
	TAB_WORKER_ARG,
	TINY_WORKER_ARG,
	TTS_WORKER_ARG,
} from "@veyyon/coding-agent/worker-args";

/**
 * `worker-args.ts` is the single owner of the hidden `__veyyon_worker_*` argv
 * markers. Each marker is a must-agree contract between the spawn site (which
 * passes it as argv) and `cli.ts`'s `runWorkerEntrypoint` (which matches it to
 * re-enter the worker). Before this module, the markers were duplicated as
 * private consts in cli.ts, as exports in the worker-client modules, and as raw
 * string literals at spawn sites; a one-character drift between any two copies
 * would leave a re-entered worker unrecognized and silently failing to start.
 * These tests pin the exact wire values and lock the single-owner invariant.
 */

describe("worker-arg marker values", () => {
	it("holds the exact argv wire string for each worker (a drift breaks re-entry)", () => {
		expect(TINY_WORKER_ARG).toBe("__veyyon_worker_tiny_inference");
		expect(TAB_WORKER_ARG).toBe("__veyyon_worker_tab");
		expect(JS_EVAL_WORKER_ARG).toBe("__veyyon_worker_js_eval");
		expect(JS_EVAL_PROCESS_ARG).toBe("__veyyon_worker_js_eval_process");
		expect(STT_WORKER_ARG).toBe("__veyyon_worker_stt");
		expect(TTS_WORKER_ARG).toBe("__veyyon_worker_tts");
		expect(MNEMOPI_EMBED_WORKER_ARG).toBe("__veyyon_worker_mnemopi_embed");
		expect(STATS_SYNC_WORKER_ARG).toBe("__veyyon_worker_stats_sync");
	});

	it("keeps the JS eval thread and process markers distinct", () => {
		// The Worker-thread js_eval and the spawned js_eval_process are different
		// entry points; the process marker is a strict superset string of the thread
		// one, so a prefix/startsWith match would wrongly conflate them.
		expect(JS_EVAL_PROCESS_ARG).not.toBe(JS_EVAL_WORKER_ARG);
		expect(JS_EVAL_PROCESS_ARG.startsWith(JS_EVAL_WORKER_ARG)).toBe(true);
	});

	it("makes every marker unique so dispatch cannot collide", () => {
		const all = [
			TINY_WORKER_ARG,
			TAB_WORKER_ARG,
			JS_EVAL_WORKER_ARG,
			JS_EVAL_PROCESS_ARG,
			STT_WORKER_ARG,
			TTS_WORKER_ARG,
			MNEMOPI_EMBED_WORKER_ARG,
			STATS_SYNC_WORKER_ARG,
		];
		expect(new Set(all).size).toBe(all.length);
	});

	it("prefixes every marker with the shared __veyyon_worker_ namespace", () => {
		for (const marker of [
			TINY_WORKER_ARG,
			TAB_WORKER_ARG,
			JS_EVAL_WORKER_ARG,
			JS_EVAL_PROCESS_ARG,
			STT_WORKER_ARG,
			TTS_WORKER_ARG,
			MNEMOPI_EMBED_WORKER_ARG,
			STATS_SYNC_WORKER_ARG,
		]) {
			expect(marker.startsWith("__veyyon_worker_")).toBe(true);
		}
	});
});

describe("worker-args single-owner lock", () => {
	it("no source file outside worker-args.ts / launch/protocol.ts hard-codes a worker marker literal", () => {
		const srcDir = join(import.meta.dir, "..", "src");
		// Owned literal homes: worker-args.ts (all __veyyon_worker_* markers) and
		// launch/protocol.ts (DAEMON_BROKER_WORKER_ARG, cohesive with the daemon
		// protocol consts). Everything else must import the const, not re-spell it.
		const allowed = new Set(["worker-args.ts", "launch/protocol.ts"]);
		// A real marker has a name character after the prefix; cli.ts's
		// `startsWith("__veyyon_worker_")` guard ends at the underscore and is fine.
		const MARKER_LITERAL = /"__veyyon_worker_[a-z]/;
		const offenders: string[] = [];
		const scan = (base: string, prefix: string) => {
			for (const ent of readdirSync(base, { withFileTypes: true })) {
				const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
				if (ent.isDirectory()) {
					scan(join(base, ent.name), rel);
					continue;
				}
				if (!ent.name.endsWith(".ts") || allowed.has(rel)) continue;
				if (MARKER_LITERAL.test(readFileSync(join(base, ent.name), "utf8"))) {
					offenders.push(rel);
				}
			}
		};
		scan(srcDir, "");
		expect(offenders).toEqual([]);
	});
});
