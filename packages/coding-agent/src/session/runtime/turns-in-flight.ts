/**
 * The prompts a session has in flight, and the macOS power assertion held while any of them runs.
 *
 * This is a session collaborator. The session begins one entry per prompt or wake turn and ends it
 * when that turn settles. The assertion is taken when the count leaves zero and released when it
 * returns to zero, so an idle session holds none.
 */
import { MacOSPowerAssertion } from "@veyyon/natives";
import { errorMessage, isBunTestRuntime, logger } from "@veyyon/utils";
import type { Settings } from "../../config/settings";

export class TurnsInFlight {
	readonly #settings: Settings;
	#count = 0;
	#powerAssertion: MacOSPowerAssertion | undefined;

	constructor(settings: Settings) {
		this.#settings = settings;
	}

	/** Whether any prompt is in flight. */
	get active(): boolean {
		return this.#count > 0;
	}

	begin(): void {
		this.#count++;
		if (this.#count === 1) this.#acquirePowerAssertion();
	}

	/**
	 * End one in-flight prompt, or every one when `all` is set. Returns whether the session is now
	 * idle, which is when the caller runs its settle work.
	 */
	end(all = false): boolean {
		this.#count = all ? 0 : Math.max(0, this.#count - 1);
		if (this.#count > 0) return false;
		this.releasePowerAssertion();
		return true;
	}

	/** Release the power assertion without touching the count. Idempotent. */
	releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: errorMessage(error) });
		}
	}

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (isBunTestRuntime()) return;
		if (this.#powerAssertion) return;
		const mode = this.#settings.get("power.sleepPrevention");
		if (mode === "off") return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "Veyyon agent session",
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: errorMessage(error) });
		}
	}
}
