/**
 * The change-notification primitive behind a package's `on*Changed` subscriptions.
 *
 * A `SettingSignal` holds a listener set, hands out unsubscribe closures, and isolates errors so a
 * single throwing listener cannot abort the rest or bubble out of a settings write. The kernel owns
 * the primitive and the registry of every signal declared with it; a package declares the signals
 * its settings fire and names none of them here.
 */

import * as logger from "@veyyon/utils/logger";

/**
 * Every signal declared in the process, in declaration order.
 *
 * The registry exists so there is ONE place that knows the full set. Without it, clearing the
 * signals meant naming all nine at the reset site, and a tenth signal added later would silently
 * not be cleared -- which is the failure mode this whole mechanism was leaking through.
 */
const SETTING_SIGNALS: SettingSignal<never[]>[] = [];

/**
 * Minimal change-notification primitive backing the exported `on*Changed`
 * subscriptions. Holds a listener set, hands out unsubscribe closures, and
 * isolates errors so a single throwing listener can't abort the rest or bubble
 * out of `Settings.set()`.
 *
 * @typeParam A - argument tuple forwarded to each listener on `fire`.
 */
export class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();
	/**
	 * Subscribers registered once at module import, which `clear` deliberately keeps.
	 *
	 * WHY THE TWO SETS ARE NOT ONE. Clearing every listener on `resetSettingsForTest` fixed a real
	 * leak -- a subscription made in one test file stayed alive for the whole process -- and broke
	 * something else in the same move: `theme/theme` subscribes at ITS OWN IMPORT and never
	 * unsubscribes, because there is nothing to unsubscribe from a module. Clearing that one meant
	 * the first reset in a process permanently disconnected the theme engine from settings, so
	 * `symbolPreset` and `colorBlindMode` stopped applying for every later file. Import-time
	 * subscribers therefore say so, and only per-instance subscriptions -- the ones an owner is
	 * expected to release -- are the leak the reset is guarding against.
	 */
	#permanent = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {
		SETTING_SIGNALS.push(this as unknown as SettingSignal<never[]>);
	}

	/**
	 * How many RELEASABLE listeners are attached. Used by the leak guard in the test suite.
	 *
	 * Import-time subscribers are excluded on purpose: there is exactly one per process and it can
	 * never be released, so counting it would make every leak threshold a moving target.
	 */
	get listenerCount(): number {
		return this.#listeners.size;
	}

	/** How many import-time subscribers are attached. One per importing module, and it stays. */
	get permanentListenerCount(): number {
		return this.#permanent.size;
	}

	/** The signal's name, so a leak report can say WHICH signal is holding listeners. */
	get name(): string {
		return this.label;
	}

	/** Drop every releasable listener, keeping import-time ones. Only {@link clearSettingSignals} calls this. */
	clear(): void {
		this.#listeners.clear();
	}

	/**
	 * Subscribe `cb`; returns an unsubscribe function.
	 *
	 * Pass `{ permanent: true }` only from a module's own import, where the subscription lasts as
	 * long as the process and no owner exists to release it.
	 */
	on(cb: (...args: A) => void, options?: { readonly permanent?: boolean }): () => void {
		const set = options?.permanent ? this.#permanent : this.#listeners;
		set.add(cb);
		return () => {
			set.delete(cb);
		};
	}

	/**
	 * Invoke every listener with `args`. Iterates a snapshot so a listener may
	 * (un)subscribe mid-fire without re-entrancy — the Hindsight backend
	 * re-registers the fresh state's listener on every rebuild — and wraps each
	 * call so a throwing listener is logged and skipped instead of aborting the
	 * rest.
	 */
	fire(...args: A): void {
		for (const cb of Array.from(this.#permanent).concat(Array.from(this.#listeners))) {
			try {
				cb(...args);
			} catch (err) {
				logger.warn(`Settings: ${this.label} hook failed`, { error: String(err) });
			}
		}
	}
}

/**
 * Drop every releasable listener from every signal declared in the process, keeping the
 * import-time ones. The store's test reset calls this so a subscription made against a torn-down
 * instance does not outlive the test file that made it.
 *
 * @internal
 */
export function clearSettingSignals(): void {
	for (const signal of SETTING_SIGNALS) signal.clear();
}

/**
 * How many listeners each setting signal currently holds, keyed by signal name.
 *
 * For the leak guard: a suite that subscribes and tears down should leave every count at zero, and
 * a non-zero count names the signal rather than leaving the reader to find it.
 *
 * @internal
 */
export function settingSignalListenerCounts(): Record<string, number> {
	return Object.fromEntries(SETTING_SIGNALS.map(signal => [signal.name, signal.listenerCount]));
}
