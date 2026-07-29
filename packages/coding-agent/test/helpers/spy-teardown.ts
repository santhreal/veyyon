import { afterEach, type Mock, spyOn } from "bun:test";

/**
 * Spies and parked waiters that are undone even when the runner KILLS the row.
 *
 * WHY THIS EXISTS. A row that exceeds its deadline never reaches its own `finally`, so whatever it
 * installed stays installed for the REST OF THAT FILE. The remaining rows then run against a live
 * mock and, worse, against a release resolver nobody will ever call: a row that parks on a gate its
 * killed predecessor was supposed to open waits until its own deadline. The result is a block of
 * rows failing with NO ASSERTION MESSAGE on any of them, which reads as a deadlock in the code under
 * test rather than as one broken row plus fallout.
 *
 * Scope, measured rather than assumed: bun restores spies at the end of each test FILE, so this does
 * NOT escape into other files sharing the process. An earlier version of this comment claimed it did,
 * on reasoning alone; a probe that deadline-kills a row and then reads whether the spy is still
 * installed showed the escape does not happen. The within-file cascade is real and is what this
 * prevents. Four suites in `test/secrets/` had the unprotected shape at once, and the misreading it
 * produces is not hypothetical: it cost three lanes an investigation into a defect that did not
 * exist, because a uniform block of deadline failures looks exactly like a real hang and nothing in
 * the output points at the row that actually broke.
 *
 * WHY IT IS A HELPER RATHER THAN A LINT RULE. The correct rule is "a prototype spy whose undo is not
 * registered for automatic teardown", and it cannot be written here: Biome 2.5.4 loads GritQL
 * plugins, but the pattern language cannot bind the spy handle through the `.mockImplementation()`
 * chain that every real call uses, variadic argument patterns match nothing, and file-scope negative
 * conditions fail to compile. A rule that merely flags every prototype spy would fire on correctly
 * written code, and a rule that fires on correct code gets suppressed — then the suppression is what
 * the next person copies. So the guarantee is attached to the ACT of installing the spy instead,
 * exactly as `useTrackedTempDirs` attaches deletion to the act of making a directory.
 *
 * Registration happens at creation, and `afterEach` drains it. Existing `finally` blocks stay
 * correct and should stay: they are the normal path, and this is the backstop for the kill path.
 * Both undos are idempotent, so running both is harmless.
 *
 * The test for this helper deliberately kills a row and then READS whether the spy survived, rather
 * than asserting that the registry was called. A registry that runs and undoes nothing passes the
 * second check and fails the first.
 *
 * A NEGATIVE CONTROL MUST BE VERIFIED TO NEGATE. Delete the thing it guards and the named row must go
 * red; if the suite stays green the control is decoration, and you have learned something about the
 * control rather than about the code. This helper is the example: with `gate()`'s registration
 * deleted, the proof above still PASSED, because restoring the spy alone was enough for the row after
 * a kill to see a clean filesystem. Half the helper was unproven while looking proven. The gate half
 * is now pinned by a fixture where the killed row leaves a shared promise only its gate can settle and
 * the next row awaits it, so deleting either half turns a named row red. Mutating the TEST rather than
 * the code under test is the technique, and it is cheap enough to be routine for anything claiming to
 * prove a backstop.
 *
 * Only a KILL or a HANG exercises any of this. A throwing `expect` runs `finally` by definition, so a
 * sabotage that produces a wrong value proves nothing here; sabotage into a hang instead.
 *
 * A row MAY restore mid-test: hold the returned mock and call `mock.mockRestore()` yourself, to model
 * a break, then a repair, then an identical second break. The registered undo is idempotent, so it is
 * safe alongside that, and the drain afterwards is a no-op.
 *
 * DECLARE THIS ABOVE THE FILE'S OWN `afterEach` HOOKS. Registration happens at construction, and bun
 * runs `afterEach` in declaration order, so a file that calls `useSpyTeardown()` BELOW its own cleanup
 * runs that cleanup while the spy is still installed. Measured with a poisoning `fs.lstat` spy and a
 * hook that stats a path: declared first, the file's own hook sees a clean filesystem; declared second,
 * it sees the poisoned one. Both orders report `0 fail`, so nothing tells you which one you have.
 *
 * @example
 * const teardown = useSpyTeardown();
 * // then, inside a row:
 * const loadSpy = teardown.spy(SecretVault.prototype, "load").mockImplementation(blockOnce);
 * const release = teardown.gate();
 * await release.reached;   // parks
 * release.open();          // and a deadline kill opens it too
 */
export interface SpyTeardown {
	/** `spyOn`, with its restore already registered. Chains exactly like `spyOn` does. */
	spy<T extends object, K extends keyof T>(target: T, key: K): Mock<Extract<T[K], (...args: never[]) => unknown>>;
	/** A one-shot gate whose release is registered, so a killed row cannot leave a waiter parked. */
	gate(): SpyGate;
	/**
	 * Any other undo, so a suite with a detacher, a restore or a close does not stand up a second
	 * registry beside this one. Drained in the same reverse order as spies and gates.
	 */
	undo(fn: () => void): void;
}

/** A parked waiter and the release that frees it. */
export interface SpyGate {
	/** Resolves when `open` is called, by the test or by teardown. */
	readonly reached: Promise<void>;
	/** Frees the waiter. Safe to call more than once. */
	open(): void;
}

export function useSpyTeardown(): SpyTeardown {
	const undos: (() => void)[] = [];

	afterEach(() => {
		// Reverse order, so a spy installed over another is removed before the one beneath it.
		while (undos.length > 0) undos.pop()?.();
	});

	return {
		spy(target, key) {
			const mock = spyOn(target, key);
			let restored = false;
			undos.push(() => {
				if (restored) return;
				restored = true;
				mock.mockRestore();
			});
			return mock;
		},
		gate(): SpyGate {
			const { promise, resolve } = Promise.withResolvers<void>();
			undos.push(resolve);
			return { reached: promise, open: resolve };
		},
		undo(fn) {
			undos.push(fn);
		},
	};
}
