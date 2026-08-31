/**
 * Hidden worker-entry marker strings.
 *
 * Each Veyyon worker is a re-entry of the same binary with a private argv
 * selector. The spawn site passes the marker as `argv` (directly or via
 * `resolveWorkerSpawnCmd`), and `runWorkerEntrypoint` in `cli.ts` matches the
 * incoming arg against the same marker to hand control to that worker before any
 * heavy module loads. Marker and match are a must-agree contract: a one-character
 * drift means the re-entered process is not recognized and the worker silently
 * fails to start, so every marker lives here exactly once.
 *
 * This module has NO runtime dependencies on purpose. `cli.ts` imports it at the
 * very top of its dispatch path, before loading the heavy worker-client modules,
 * so it must stay free to import (string constants only).
 *
 * One marker lives elsewhere by design: `DAEMON_BROKER_WORKER_ARG` is defined in
 * `launch/protocol.ts` alongside the rest of the daemon-broker protocol constants
 * (PTY size, handoff keys). It is already single-owner there; do not copy it here.
 */

/** Tiny-inference (title/summary) worker. Owner + dispatch. */
export const TINY_WORKER_ARG = "__veyyon_worker_tiny_inference";

/** Browser tab-supervisor worker. */
export const TAB_WORKER_ARG = "__veyyon_worker_tab";

/** JS eval Worker thread (in-process VM contexts). */
export const JS_EVAL_WORKER_ARG = "__veyyon_worker_js_eval";

/** JS eval spawned process (per-session isolated process, distinct from the thread worker). */
export const JS_EVAL_PROCESS_ARG = "__veyyon_worker_js_eval_process";

/** Speech-to-text (ASR) worker. */
export const STT_WORKER_ARG = "__veyyon_worker_stt";

/** Text-to-speech worker. */
export const TTS_WORKER_ARG = "__veyyon_worker_tts";

/** MnemoPI embedding worker. */
export const MNEMOPI_EMBED_WORKER_ARG = "__veyyon_worker_mnemopi_embed";

/** Background stats-sync worker. */
export const STATS_SYNC_WORKER_ARG = "__veyyon_worker_stats_sync";
