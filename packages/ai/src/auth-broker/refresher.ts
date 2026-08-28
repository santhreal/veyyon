import * as logger from "@veyyon/utils/logger";
import { type AuthStorage, withAuthHttpConcurrency } from "../auth-storage";
import { isDefinitiveOAuthFailure } from "../error/flags";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types";

export interface AuthBrokerRefresherOptions {
	storage: AuthStorage;
	refreshSkewMs?: number;
	refreshIntervalMs?: number;
	now?: () => number;
}

export interface AuthBrokerRefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepAt: number;
}

export class AuthBrokerRefresher {
	readonly #storage: AuthStorage;
	readonly #refreshSkewMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#nextSweepAt: number;
	constructor(opts: AuthBrokerRefresherOptions) {
		this.#storage = opts.storage;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#now = opts.now ?? Date.now;
		this.#nextSweepAt = this.#now();
	}

	start(): void {
		if (this.#timer !== undefined) return;
		this.#nextSweepAt = this.#now();
		void this.tick();
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#refreshIntervalMs);
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	getSchedule(): AuthBrokerRefresherSchedule {
		return {
			enabled: true,
			intervalMs: this.#refreshIntervalMs,
			skewMs: this.#refreshSkewMs,
			nextSweepAt: this.#nextSweepAt,
		};
	}

	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#nextSweepAt = this.#now();
		try {
			await this.#storage.reload();
			const snapshot = this.#storage.exportSnapshot();
			const now = this.#now();
			const deadline = now + this.#refreshSkewMs;
			const targets: number[] = [];
			for (const entry of snapshot.credentials) {
				if (entry.credential.type !== "oauth") continue;
				const expires = entry.credential.expires;
				if (typeof expires !== "number" || !Number.isFinite(expires)) continue;
				if (expires > deadline) continue;
				targets.push(entry.id);
			}
			await Promise.all(targets.map(id => withAuthHttpConcurrency(() => this.#refreshOne(id))));
		} finally {
			this.#running = false;
			this.#nextSweepAt = this.#now() + this.#refreshIntervalMs;
		}
	}

	async #refreshOne(id: number): Promise<void> {
		try {
			await this.#storage.refreshCredentialById(id);
		} catch (error) {
			const errorMsg = String(error);
			if (isDefinitiveOAuthFailure(errorMsg)) {
				logger.warn("auth-broker refresh failed definitively", { id, error: errorMsg });
			} else {
				logger.debug("auth-broker refresh failed (transient)", { id, error: errorMsg });
			}
		}
	}
}
