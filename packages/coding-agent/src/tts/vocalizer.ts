import { errorMessage, logger } from "@veyyon/utils";
import { settings } from "../config/settings-instance";
import { DEFAULT_TTS_VOICE } from "./models";
import { SpeakableStream } from "./speakable";
import { BlockAccumulator, type SpeechEnhancer } from "./speech-enhancer";
import { createStreamingPlayer, DUCK_GAIN } from "./streaming-player";
import { type TtsStreamHandle, ttsClient } from "./tts-client";

const IDLE_FLUSH_MS = 1000;
const COALESCE_MIN_CHARS = 400;
const MAX_REWRITES_IN_FLIGHT = 2;

export interface VocalizerPlayer {
	start(sampleRate: number): void;
	write(pcm: Float32Array): void;
	setGain(gain: number): void;
	end(): Promise<void>;
	stop(): void;
}

interface EnhancedUtterance {
	blocks: BlockAccumulator;
	speakable: SpeakableStream;
	pending: string[];
	pendingChars: number;
	dispatchedFirst: boolean;
	order: Promise<void>;
	handle: TtsStreamHandle | null;
	abort: AbortController;
}

export class Vocalizer {
	#handle: TtsStreamHandle | null = null;
	#speakable: SpeakableStream | null = null;
	#enhanced: EnhancedUtterance | null = null;
	#enhancer: SpeechEnhancer | null = null;
	#idleTimer: NodeJS.Timeout | null = null;
	#liveAborts = new Set<AbortController>();
	#livePlayers = new Set<VocalizerPlayer>();
	#chain: Promise<void> = Promise.resolve();
	#ducked = false;
	#rewriteSlots = MAX_REWRITES_IN_FLIGHT;
	#slotWaiters: Array<() => void> = [];
	#createPlayer: () => VocalizerPlayer;

	constructor(createPlayer: () => VocalizerPlayer = createStreamingPlayer) {
		this.#createPlayer = createPlayer;
	}

	setEnhancer(enhancer: SpeechEnhancer | null): void {
		this.#enhancer = enhancer;
	}

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

	speak(text: string): void {
		this.pushDelta(text);
		this.flush();
	}

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

	isSpeaking(): boolean {
		return this.#livePlayers.size > 0 || this.#liveAborts.size > 0 || this.#handle !== null;
	}

	duck(): void {
		this.#ducked = true;
		for (const player of this.#livePlayers) player.setGain(DUCK_GAIN);
	}

	unduck(): void {
		this.#ducked = false;
		for (const player of this.#livePlayers) player.setGain(1);
	}

	idle(): Promise<void> {
		return this.#chain;
	}

	#pushEnhanced(text: string): void {
		if (!this.#enhanced) this.#enhanced = this.#newEnhancedUtterance();
		const utterance = this.#enhanced;
		for (const block of utterance.blocks.push(text)) {
			utterance.pending.push(block);
			utterance.pendingChars += block.length;
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
			if (rewritten === "") return;
			const spoken = rewritten ?? block;
			const segments = utterance.speakable.push(spoken.endsWith("\n") ? spoken : `${spoken}\n`);
			if (segments.length === 0) return;
			if (!utterance.handle) utterance.handle = this.#openSession(utterance.abort);
			for (const segment of segments) utterance.handle.push(segment);
		});
	}

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

	#pushSegments(segments: string[]): void {
		if (segments.length === 0) return;
		if (!this.#handle) {
			const abort = new AbortController();
			this.#liveAborts.add(abort);
			this.#handle = this.#openSession(abort);
		}
		for (const segment of segments) this.#handle.push(segment);
	}

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

export const vocalizer = new Vocalizer();
