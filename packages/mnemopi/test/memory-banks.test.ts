import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BankManager,
	bankDbPath,
	bankExists,
	createBank,
	deleteBank,
	getBank,
	listBanks,
	resetBankForTests,
	setBank,
	ValueError,
} from "@veyyon/mnemopi/core/banks";

describe("BankManager", () => {
	it("creates, lists, renames, stats, and deletes isolated bank directories", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-banks-"));
		try {
			const manager = new BankManager(root);
			const dbPath = manager.createBank("work");
			expect(existsSync(dbPath)).toBe(true);
			expect(manager.listBanks()).toEqual(["default", "work"]);
			expect(manager.bankExists("work")).toBe(true);
			expect(manager.getBankDbPath("default")).toBe(join(root, "mnemopi.db"));
			expect(manager.getBankDbPath("work")).toBe(join(root, "banks", "work", "mnemopi.db"));
			expect(manager.getBankStats("work").db_size_bytes).toBeGreaterThanOrEqual(0);
			const renamed = manager.renameBank("work", "project_a");
			expect(renamed).toBe(join(root, "banks", "project_a", "mnemopi.db"));
			expect(manager.bankExists("work")).toBe(false);
			expect(manager.bankExists("project_a")).toBe(true);
			expect(manager.deleteBank("project_a")).toBe(true);
			expect(manager.deleteBank("missing")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates names and protects default deletion", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-banks-"));
		try {
			const manager = new BankManager(root);
			expect(() => manager.createBank("bank with spaces")).toThrow();
			expect(() => manager.createBank("bank/with/slashes")).toThrow();
			expect(() => manager.createBank("bank.with.dots")).toThrow();
			expect(() => manager.getBankDbPath("../escape")).toThrow(ValueError);
			expect(() => manager.deleteBank("../escape", true)).toThrow(ValueError);
			expect(() => bankDbPath("../escape", root)).toThrow(ValueError);
			// renameBank validates BOTH names, and the SOURCE guard must reject a
			// traversal by NAME (not merely because the target happened not to exist).
			// The rejection message proves validation fired, not the existsSync miss.
			expect(() => manager.renameBank("../escape", "safe")).toThrow(/Invalid bank name/);
			expect(() => manager.renameBank("banks/nested", "safe")).toThrow(/Invalid bank name/);
			// The destination name is still validated too. A valid, non-default source
			// reaches newName validation and is rejected there before any filesystem touch.
			expect(() => manager.renameBank("validsource", "../escape")).toThrow(/Invalid bank name/);
			expect(manager.getBankDbPath("")).toBe(join(root, "mnemopi.db"));
			expect(() => manager.deleteBank("default")).toThrow();
			expect(manager.deleteBank("default", true)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to move an existing out-of-tree directory into the bank store via a traversal source name", () => {
		// The concrete data-safety guarantee behind the renameBank source-name guard.
		// banksDir is `<root>/banks`, so an unvalidated oldName of "../outside" resolves
		// to `<root>/outside` — a real directory that EXISTS. Without validating the
		// source name, renameBank would `renameSync(<root>/outside, <root>/banks/captured)`,
		// silently relocating an out-of-tree directory (and whatever the user kept there)
		// into the bank store. This test proves the traversal is rejected and the outside
		// directory is left exactly where it was.
		const root = mkdtempSync(join(tmpdir(), "mnemopi-banks-"));
		try {
			const manager = new BankManager(root);
			const outside = join(root, "outside");
			mkdirSync(outside, { recursive: true });
			writeFileSync(join(outside, "keep.txt"), "user data");

			expect(() => manager.renameBank("../outside", "captured")).toThrow(ValueError);

			// The outside directory and its contents are untouched.
			expect(existsSync(outside)).toBe(true);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("user data");
			// Nothing was captured into the bank store.
			expect(existsSync(join(root, "banks", "captured"))).toBe(false);
			expect(manager.listBanks()).toEqual(["default"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("module-level helpers operate on the requested data dir", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-banks-"));
		try {
			const dbPath = createBank("mod_test", root);
			expect(existsSync(dbPath)).toBe(true);
			expect(bankExists("mod_test", root)).toBe(true);
			expect(listBanks(root)).toContain("mod_test");
			expect(deleteBank("mod_test", root)).toBe(true);
			expect(bankExists("mod_test", root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("switches the process default bank", () => {
		resetBankForTests();
		expect(getBank()).toBe("default");
		setBank("work");
		expect(getBank()).toBe("work");
		resetBankForTests();
	});
});
