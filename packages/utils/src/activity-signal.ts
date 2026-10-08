/**
 * Lets a periodic sampler stop its timer while the process rests and start it again at the next
 * piece of work a host reports.
 *
 * Bun's idle collector runs a collection every second until the heap's block and extra-memory
 * counters hold still across 30 consecutive collections, and each collection wakes every one of
 * the collector's helper threads. JavaScript that runs between two collections, a 250ms sampling
 * tick included, moves the counters, so a process that ticks never reaches the 30s rate.
 * MEASURED on the linux-x64 binary of an interactive session at rest: 3,617 thread wakeups in 30s,
 * 2,738 of them the collector's helpers. With the samplers parked, 131 wakeups in 60s and none of
 * them the helpers', 90 seconds after launch.
 *
 * A sampler that found the process quiet calls `park(wake)` and arms nothing. The host calls
 * `report()` on every piece of its work, which runs each parked `wake` once. Parking requires an
 * attached host: while none is attached, `park` returns false and the sampler keeps its timer, so
 * a mode without a host samples as before.
 */
export class ActivitySignal {
	#hosts = 0;
	#parked = new Set<() => void>();

	/**
	 * Registers a host that calls `report()` on all of its work, and returns the function that
	 * unregisters it. When the last host leaves, every parked `wake` runs, since nothing reports
	 * work any more.
	 */
	attachHost(): () => void {
		this.#hosts++;
		let attached = true;
		return () => {
			if (!attached) return;
			attached = false;
			this.#hosts--;
			if (this.#hosts === 0) this.#wakeAll();
		};
	}

	/** Holds `wake` until the next `report()`. Returns false, holding nothing, while no host is attached. */
	park(wake: () => void): boolean {
		if (this.#hosts === 0) return false;
		this.#parked.add(wake);
		return true;
	}

	/** Drops a parked `wake` without running it. */
	unpark(wake: () => void): void {
		this.#parked.delete(wake);
	}

	/** Runs every parked `wake` once. Costs one size check while nothing is parked. */
	report(): void {
		if (this.#parked.size > 0) this.#wakeAll();
	}

	#wakeAll(): void {
		const parked = this.#parked;
		this.#parked = new Set();
		for (const wake of parked) wake();
	}
}

/** The process's signal. The terminal UI attaches to it and reports each keystroke and frame. */
export const processActivity = new ActivitySignal();
