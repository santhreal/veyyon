/** Streaming assistant speech-vocalization. The vocalizer turns the assistant's STREAMING output into spoken audio as a */
import { errorMessage, logger } from "@veyyon/utils";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../config/settings-instance";
import { DEFAULT_TTS_VOICE } from "./models";
import { SpeakableStream } from "./speakable";
import { BlockAccumulator, type SpeechEnhancer } from "./speech-enhancer";
import { createStreamingPlayer, DUCK_GAIN } from "./streaming-player";
import { type TtsStreamHandle, ttsClient } from "./tts-client";

/** Quiet time on the delta stream before the buffered partial is spoken. */
const IDLE_FLUSH_MS = 1000;
/** Coalesce completed blocks until this many chars before one rewrite call. */
const COALESCE_MIN_CHARS = 400;
/** Bounded rewrite concurrency across utterances. */
const MAX_REWRITES_IN_FLIGHT = 2;

export interface VocalizerPlayer {
	start(sampleRate: number): void;
	write(pcm: Float32Array): void;
	setGain(gain: number): void;
	end(): Promise<void>;
	stop(): void;
}

/** State of one enhanced-mode utterance. Detached from the vocalizer at {@link Vocalizer.flush} so in-flight rewrites finish and the session closes */
interface EnhancedUtterance {
	blocks: BlockAccumulator;
	/** Segments the (rewritten) prose; also the safety net for leaked markup. */
	speakable: SpeakableStream;
	/** Completed blocks held back for coalescing into one rewrite call. */
	pending: string[];
	pendingChars: number;
	/** First rewrite skips coalescing for fast time-to-first-audio. */
	dispatchedFirst: boolean;
	/** FIFO chain that pushes rewrite results in block order. */
	order: Promise<void>;
	handle: TtsStreamHandle | null;
	/** Aborted by {@link Vocalizer.clear} (current or detached); gates every deferred step. */
	abort: AbortController;
}

export class Vocalizer {
	/** Mechanical mode: open stream session for the current utterance. */
	#handle: TtsStreamHandle | null = null;
	/** Mechanical mode: markdown → segment transform for the current utterance. */
	#speakable: SpeakableStream | null = null;
	/** Enhanced mode: the utterance currently receiving deltas. */
	#enhanced: EnhancedUtterance | null = null;
	/** Per-session rewrite service; wired by the event controller, null elsewhere. */
	#enhancer: SpeechEnhancer | null = null;
	/** Fires when the delta stream goes quiet mid-sentence; speaks the partial. */
	#idleTimer: NodeJS.Timeout | null = null;
	/** Abort controllers of every not-yet-finished utterance; all aborted on {@link clear}. */
	#liveAborts = new Set<AbortController>();
	/** Players of every not-yet-finished utterance; ducked together, stopped on {@link clear}. */
	#livePlayers = new Set<VocalizerPlayer>();
	/** Serialized playback chain across utterances; awaited by {@link idle}. */
	#chain: Promise<void> = Promise.resolve();
	/** Whether the user is currently speaking; new sessions open ducked. */
	#ducked = false;
	/** Available rewrite slots; blocks queue when exhausted. */
	#rewriteSlots = MAX_REWRITES_IN_FLIGHT;
	#slotWaiters: Array<() => void> = [];
	#createPlayer: () => VocalizerPlayer;

	constructor(createPlayer: () => VocalizerPlayer = createStreamingPlayer) {
		this.#createPlayer = createPlayer;
	}

	/** Wire (or drop) the per-session enhanced-rewrite service. */
	setEnhancer(enhancer: SpeechEnhancer | null): void {
		this.#enhancer = enhancer;
	}

	/** Stream a delta of assistant text into the pipeline. No-op when vocalization is disabled. The synthesis session (worker, player) is only */
	pushDelta(text: string): void {
		if (!settings.get("speech.enabled")) return;
		if (!text) return;
		if (this.#enhanced || (!this.#speakable && this.#enhancer && settings.get("speech.enhanced"))) {
			this.#pushEnhanced(text);
			return;
		}
		this.#speakable ??= new SpeakableStream();
		const speakable = this.#speakable;
		this.#pushSegments(speakable.push(text));
		this.#armIdle(() => {
			if (this.#speakable !== speakable) return;
			this.#pushSegments(speakable.flushIdle());
		});
	}

	/** Close the current input stream (call at message/turn end). Drains the trailing partial as final segments; in enhanced mode the session ends */
	flush(): void {
		this.#clearIdleTimer();
		const utterance = this.#enhanced;
		if (utterance) {
			this.#enhanced = null;
			const last = utterance.blocks.flush();
			if (last !== null) {
				utterance.pending.push(last);
				utterance.pendingChars += last.length;
			}
			this.#dispatchPending(utterance);
			utterance.order = utterance.order.then(() => {
				if (utterance.abort.signal.aborted) return;
				utterance.handle?.end();
				// A rewrite-only utterance (nothing speakable, no session) has no
				// playback teardown to reap its abort controller — do it here.
				if (!utterance.handle) this.#liveAborts.delete(utterance.abort);
			});
			return;
		}
		const speakable = this.#speakable;
		this.#speakable = null;
		if (speakable) this.#pushSegments(speakable.flush());
		this.#handle?.end();
		this.#handle = null;
	}

	/** Speak a complete piece of text in one shot (ask questions, yield-mode final message): stream it in and immediately close the input. No-op when disabled. */
	speak(text: string): void {
		this.pushDelta(text);
		this.flush();
	}

	/** Interrupt and drop every utterance, killing in-flight playback, synthesis, and rewrites (new turn / user message / Esc interrupt). Audio stops at once. */
	clear(): void {
		this.#clearIdleTimer();
		this.#enhanced = null;
		this.#speakable = null;
		this.#handle = null;
		for (const abort of this.#liveAborts) abort.abort();
		this.#liveAborts.clear();
		for (const player of this.#livePlayers) player.stop();
		this.#livePlayers.clear();
	}

	/** True while any utterance is still audible or synthesizing — a live player, an unfinished stream handle, or an in-flight rewrite is enough. */
	isSpeaking(): boolean {
		return this.#livePlayers.size > 0 || this.#liveAborts.size > 0 || this.#handle !== null;
	}

	/** Lower the volume while the user is speaking (push-to-talk), so speech doesn't drown them out. */
	duck(): void {
		this.#ducked = true;
		for (const player of this.#livePlayers) player.setGain(DUCK_GAIN);
	}

	/** Restore full volume once the user stops speaking. */
	unduck(): void {
		this.#ducked = false;
		for (const player of this.#livePlayers) player.setGain(1);
	}

	/** Resolve once the playback chain has drained (tests / shutdown). */
	idle(): Promise<void> {
		return this.#chain;
	}

	#pushEnhanced(text: string): void {
		if (!this.#enhanced) this.#enhanced = this.#newEnhancedUtterance();
		const utterance = this.#enhanced;
		for (const block of utterance.blocks.push(text)) {
			utterance.pending.push(block);
			utterance.pendingChars += block.length;
			// The first rewrite dispatches immediately for fast first audio;
			// later blocks coalesce so a heading and its list cost one call.
			if (!utterance.dispatchedFirst || utterance.pendingChars >= COALESCE_MIN_CHARS) {
				this.#dispatchPending(utterance);
			}
		}
		this.#armIdle(() => {
			if (this.#enhanced !== utterance) return;
			const partial = utterance.blocks.flushPartial();
			if (partial !== null) {
				utterance.pending.push(partial);
				utterance.pendingChars += partial.length;
			}
			this.#dispatchPending(utterance);
		});
	}

	#newEnhancedUtterance(): EnhancedUtterance {
		const abort = new AbortController();
		this.#liveAborts.add(abort);
		return {
			blocks: new BlockAccumulator(),
			speakable: new SpeakableStream(),
			pending: [],
			pendingChars: 0,
			dispatchedFirst: false,
			order: Promise.resolve(),
			handle: null,
			abort,
		};
	}

	/** Send the coalesced pending blocks to the rewriter and chain the ordered push of the result. The completion runs concurrently (bounded by the */
	#dispatchPending(utterance: EnhancedUtterance): void {
		if (utterance.pending.length === 0) return;
		const block = utterance.pending.join("\n\n");
		utterance.pending = [];
		utterance.pendingChars = 0;
		utterance.dispatchedFirst = true;
		const result = this.#boundedRewrite(block, utterance.abort.signal);
		utterance.order = utterance.order.then(async () => {
			const rewritten = await result;
			if (utterance.abort.signal.aborted) return;
			// Empty string: the model judged the block unspeakable (pure code).
			if (rewritten === "") return;
			// Null: rewrite failed/timed out — mechanical cleanup of the raw
			// block via the SpeakableStream keeps speech flowing.
			const spoken = rewritten ?? block;
			const segments = utterance.speakable.push(spoken.endsWith("\n") ? spoken : `${spoken}\n`);
			if (segments.length === 0) return;
			if (!utterance.handle) utterance.handle = this.#openSession(utterance.abort);
			for (const segment of segments) utterance.handle.push(segment);
		});
	}

	/** Run one rewrite through the bounded slot pool; never rejects. */
	async #boundedRewrite(block: string, signal: AbortSignal): Promise<string | null> {
		await this.#acquireSlot();
		try {
			if (signal.aborted || !this.#enhancer) return null;
			return await this.#enhancer.rewrite(block, signal);
		} finally {
			this.#releaseSlot();
		}
	}

	#acquireSlot(): Promise<void> {
		if (this.#rewriteSlots > 0) {
			this.#rewriteSlots--;
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#slotWaiters.push(resolve);
		return promise;
	}

	#releaseSlot(): void {
		const next = this.#slotWaiters.shift();
		if (next) next();
		else this.#rewriteSlots++;
	}

	/** Mechanical mode: feed ready segments, opening the session lazily. */
	#pushSegments(segments: string[]): void {
		if (segments.length === 0) return;
		if (!this.#handle) {
			const abort = new AbortController();
			this.#liveAborts.add(abort);
			this.#handle = this.#openSession(abort);
		}
		for (const segment of segments) this.#handle.push(segment);
	}

	/** Open a streaming-synthesis session and chain its playback after any prior utterance's, so sequential utterances never overlap. */
	#openSession(abort: AbortController): TtsStreamHandle {
		const modelKey = settings.get("tts.localModel");
		const voice = settings.get("speech.voice") || DEFAULT_TTS_VOICE;
		const handle = ttsClient.synthesizeStream(modelKey, { voice, signal: abort.signal });
		const player = this.#createPlayer();
		player.setGain(this.#ducked ? DUCK_GAIN : 1);
		this.#liveAborts.add(abort);
		this.#livePlayers.add(player);
		this.#chain = this.#chain.then(async () => {
			try {
				await this.#play(handle, player, abort.signal);
			} finally {
				this.#liveAborts.delete(abort);
				this.#livePlayers.delete(player);
			}
		});
		return handle;
	}

	/** (Re)arm the stall timer: if no delta arrives for {@link IDLE_FLUSH_MS}, speak buffered text instead of holding it through a tool call or */
	#armIdle(onIdle: () => void): void {
		this.#clearIdleTimer();
		const timer = setTimeout(() => {
			this.#idleTimer = null;
			onIdle();
		}, IDLE_FLUSH_MS);
		timer.unref?.();
		this.#idleTimer = timer;
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer === null) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	/** Feed each synthesized segment into the player in arrival order; abort stops it. */
	async #play(handle: TtsStreamHandle, player: VocalizerPlayer, signal: AbortSignal): Promise<void> {
		let started = false;
		try {
			for await (const chunk of handle.chunks) {
				if (signal.aborted) break;
				if (!started) {
					player.start(chunk.sampleRate);
					started = true;
				}
				player.write(chunk.pcm);
			}
			if (started && !signal.aborted) {
				await player.end();
				return;
			}
		} catch (error) {
			logger.debug("vocalizer: stream failed", {
				error: errorMessage(error),
			});
		}
		player.stop();
	}
}

/** Process-level vocalizer shared by the event controller and the ask tool. */
export const vocalizer = new Vocalizer();
