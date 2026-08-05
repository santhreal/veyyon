/**
 * Asking where a bank lives must not create the place it would live.
 *
 * THE LEAK THIS PREVENTS. `BankManager`'s constructor ran `mkdirSync(this.banksDir)`, and
 * every read in the package goes through a constructor: `bankDbPath()`, `bankExists()`,
 * `listBanks()` and `getBankStats()` each build a manager to answer one question, and
 * `resolveDbPath()` in `core/memory.ts` builds one (`new BankManager()`, no argument) purely
 * to SPELL a path. With no argument the data dir is `dataDir()`, which is
 * `~/.hermes/mnemopi/data` unless `MNEMOPI_DATA_DIR` says otherwise. So spelling a path, or
 * asking whether a bank exists, created `~/.hermes/mnemopi/data/banks` in the operator's real
 * home. Nothing failed and nothing could: the answer returned is correct either way, and the
 * only trace is a directory tree nobody asked for.
 *
 * That is the same defect shape as the 131 `~/.veyyon-mnemopi-profile-iso-*` directories
 * counted in one real home, one layer down: a path resolved for a READ that materializes
 * itself as a side effect. `createBank()` is the single operator action that needs the
 * directory, and its own recursive `mkdirSync` makes it, so removing the constructor's was
 * a pure subtraction.
 *
 * WHY THE ASSERTION IS "NOTHING EXISTS" AND NOT "THE HOME IS UNCHANGED". Every path here is
 * a temp root that was never created, so `existsSync(root) === false` is decidable, exact,
 * and independent of whatever home the process was given. Point the manager at a directory
 * that does not exist and the constructor either leaves it that way or it does not.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BankManager,
	bankDbPath,
	bankExists,
	getBank,
	listBanks,
	resetBankForTests,
	setBank,
} from "@veyyon/mnemopi/core/banks";

/** A path under the system temp directory that is guaranteed NOT to exist. */
function unmadeRoot(): string {
	const parent = mkdtempSync(join(tmpdir(), "mnemopi-bank-lookup-"));
	created.push(parent);
	return join(parent, "data-dir-that-was-never-created");
}

const created: string[] = [];

afterEach(() => {
	resetBankForTests();
	while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

describe("a bank lookup creates no directory", () => {
	it("constructs a manager against a nonexistent data dir without creating it", () => {
		const root = unmadeRoot();
		const manager = new BankManager(root);
		expect(manager.dataDir).toBe(root);
		expect(manager.banksDir).toBe(join(root, "banks"));
		expect(existsSync(root)).toBe(false);
	});

	/**
	 * The four read methods, each on its own manager, because the leak was per-construction:
	 * one shared manager would hide three of them behind the first one's side effect.
	 */
	it("answers every read against a nonexistent data dir without creating it", () => {
		const root = unmadeRoot();

		expect(new BankManager(root).getBankDbPath("default")).toBe(join(root, "mnemopi.db"));
		expect(new BankManager(root).getBankDbPath("work")).toBe(join(root, "banks", "work", "mnemopi.db"));
		expect(new BankManager(root).bankExists("work")).toBe(false);
		expect(new BankManager(root).listBanks()).toEqual(["default"]);
		expect(new BankManager(root).getBankStats("work").exists).toBe(false);

		expect(existsSync(root)).toBe(false);
	});

	/** The module-level wrappers each build their own manager, so each is its own chance to leak. */
	it("answers the free-function reads without creating the data dir", () => {
		const root = unmadeRoot();

		expect(bankExists("work", root)).toBe(false);
		expect(listBanks(root)).toEqual(["default"]);
		setBank("work");
		expect(getBank()).toBe("work");
		expect(bankDbPath(undefined, root)).toBe(join(root, "banks", "work", "mnemopi.db"));

		expect(existsSync(root)).toBe(false);
	});

	/**
	 * `MNEMOPI_DATA_DIR` is what `dataDir()` reads, and the no-argument constructor is the
	 * exact call `core/memory.ts` makes. Pointing it at a path that does not exist reproduces
	 * the real-home case without needing a real home: if construction still materialized its
	 * directory, this is where `~/.hermes/mnemopi/data/banks` came from.
	 */
	it("does not create the configured data dir when constructed with no argument", () => {
		const root = unmadeRoot();
		const previous = process.env.MNEMOPI_DATA_DIR;
		process.env.MNEMOPI_DATA_DIR = root;
		try {
			expect(new BankManager().getBankDbPath("work")).toBe(join(root, "banks", "work", "mnemopi.db"));
			expect(existsSync(root)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.MNEMOPI_DATA_DIR;
			else process.env.MNEMOPI_DATA_DIR = previous;
		}
	});

	/**
	 * The subtraction must not have cost `createBank()` its directory. It is the one caller
	 * that legitimately creates, and it creates the whole tree from a root that does not exist.
	 */
	it("still builds the whole tree when a bank is actually created", () => {
		const root = unmadeRoot();
		const dbPath = new BankManager(root).createBank("work");
		expect(dbPath).toBe(join(root, "banks", "work", "mnemopi.db"));
		expect(existsSync(dbPath)).toBe(true);
		expect(new BankManager(root).listBanks()).toEqual(["default", "work"]);
	});
});
