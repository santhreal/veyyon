/** Hidden worker-entry marker strings. Each Veyyon worker is a re-entry of the same binary with a private argv */

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
