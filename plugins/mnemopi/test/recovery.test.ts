import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	createBackup,
	emergencyRestore,
	FileNotFoundError,
	getDefaultPaths,
	healthCheck,
	listBackups,
	restoreBackup,
	rotateBackups,
	verifyIntegrity,
} from "@veyyon/mnemopi/dr/recovery";

const tempDirs: string[] = [];
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-recovery-"));
	tempDirs.push(dir);
	return dir;
}

function createSqliteDb(path: string): void {
	const db = new Database(path, { create: true, readwrite: true, strict: true });
	try {
		db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
		db.prepare("INSERT INTO memories (content) VALUES (?)").run("backup me");
	} finally {
		db.close();
	}
}

function readMemory(path: string): string {
	const db = new Database(path, { create: false, readwrite: false, strict: true });
	try {
		const row = db.query("SELECT content FROM memories WHERE id = 1").get() as {
			content: string;
		} | null;
		expect(row).not.toBeNull();
		if (row === null) throw new Error("Expected memory row to exist");
		return row.content;
	} finally {
		db.close();
	}
}

function writeCorruptSqliteBackup(path: string): void {
	writeFileSync(path, gzipSync(Buffer.concat([SQLITE_HEADER, Buffer.from("corrupt backup payload")])));
}

function withFrozenNow<T>(iso: string, fn: () => T): T {
	const realDate = Date;
	const fixedMs = realDate.parse(iso);
	class FrozenDate extends realDate {
		constructor(value?: string | number | Date) {
			if (value === undefined) super(fixedMs);
			else super(value);
		}

		static now(): number {
			return fixedMs;
		}
	}
	globalThis.Date = FrozenDate as DateConstructor;
	try {
		return fn();
	} finally {
		globalThis.Date = realDate;
	}
}

afterEach(() => {
	for (;;) {
		const dir = tempDirs.pop();
		if (dir === undefined) break;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SQLite recovery helpers", () => {
	it("creates a compressed backup with metadata", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);

		const backup = createBackup(dbPath, backupDir);

		expect(backup.backup_path.startsWith(backupDir)).toBe(true);
		expect(backup.backup_path.endsWith(".db.gz")).toBe(true);
		expect(existsSync(backup.backup_path)).toBe(true);
		expect(existsSync(backup.metadata_path)).toBe(true);
		expect(backup.original_size).toBe(statSync(dbPath).size);
		expect(backup.backup_size).toBe(statSync(backup.backup_path).size);
		expect(backup.compressed).toBe(true);
		expect(
			Buffer.from(gunzipSync(readFileSync(backup.backup_path)))
				.subarray(0, 16)
				.toString("binary"),
		).toBe("SQLite format 3\0");
	});

	it("creates distinct backup files when called twice in the same second", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);

		const [first, second] = withFrozenNow("2026-05-30T12:00:00.000Z", () => [
			createBackup(dbPath, backupDir),
			createBackup(dbPath, backupDir),
		]);

		expect(first.backup_path).not.toBe(second.backup_path);
		expect(first.metadata_path).not.toBe(second.metadata_path);
		expect(existsSync(first.backup_path)).toBe(true);
		expect(existsSync(second.backup_path)).toBe(true);
		expect(existsSync(first.metadata_path)).toBe(true);
		expect(existsSync(second.metadata_path)).toBe(true);
	});

	it("returns true for a valid SQLite database integrity check", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		createSqliteDb(dbPath);

		expect(verifyIntegrity(dbPath)).toBe(true);
	});

	it("restores a backup to a new path", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const restoredPath = join(dir, "restored.db");
		createSqliteDb(dbPath);
		const backup = createBackup(dbPath, join(dir, "backups"));

		const restored = restoreBackup(backup.backup_path, restoredPath);

		expect(restored).toEqual({
			restored: true,
			backup_used: backup.backup_path,
			database_path: restoredPath,
			integrity_check: true,
		});
		expect(verifyIntegrity(restoredPath)).toBe(true);
		expect(readMemory(restoredPath)).toBe("backup me");
	});

	it("keeps the current WAL database untouched when a staged restore fails integrity", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		mkdirSync(backupDir, { recursive: true });
		const badBackup = join(backupDir, "mnemopi_backup_20260530_120000.db.gz");
		writeCorruptSqliteBackup(badBackup);
		const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
		try {
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
			db.prepare("INSERT INTO memories (content) VALUES (?)").run("wal protected");
			expect(existsSync(`${dbPath}-wal`)).toBe(true);

			expect(() => restoreBackup(badBackup, dbPath)).toThrow(/integrity/);

			expect(existsSync(`${dbPath}-wal`)).toBe(true);
			const row = db.query("SELECT content FROM memories WHERE id = 1").get() as { content: string } | null;
			expect(row?.content).toBe("wal protected");
		} finally {
			db.close();
		}
	});

	it("leaves the original database intact when emergency restore exhausts corrupt backups", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);
		mkdirSync(backupDir, { recursive: true });
		writeCorruptSqliteBackup(join(backupDir, "mnemopi_backup_20260530_120000.db.gz"));

		expect(() => emergencyRestore(backupDir, dbPath)).toThrow("All backups failed integrity check");
		expect(verifyIntegrity(dbPath)).toBe(true);
		expect(readMemory(dbPath)).toBe("backup me");
	});
});

// Drop a placeholder backup + metadata sidecar with a controlled name so
// list/rotate ordering is deterministic (createBackup names by wall-clock).
function dropBackupFile(backupDir: string, stamp: string, withMeta = true): string {
	mkdirSync(backupDir, { recursive: true });
	const file = join(backupDir, `mnemopi_backup_${stamp}.db.gz`);
	writeFileSync(file, gzipSync(Buffer.from(`payload-${stamp}`)));
	if (withMeta) writeFileSync(`${file.slice(0, -3)}.gz.json`, JSON.stringify({ timestamp: stamp, compressed: true }));
	return file;
}

function withEnv<T>(overrides: Record<string, string>, fn: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("getDefaultPaths", () => {
	it("honors MNEMOPI_BACKUP_DIR and otherwise derives backups next to the data dir", () => {
		const explicit = getDefaultPaths({ MNEMOPI_DATA_DIR: "/d/data", MNEMOPI_BACKUP_DIR: "/custom/backups" });
		expect(explicit.dataDir).toBe("/d/data");
		expect(explicit.backupDir).toBe("/custom/backups");
		expect(explicit.dbPath).toBe("/d/data/mnemopi.db");

		const derived = getDefaultPaths({ MNEMOPI_DATA_DIR: "/d/data" });
		expect(derived.backupDir).toBe("/d/backups");
	});
});

describe("listBackups", () => {
	it("returns [] for a missing directory", () => {
		expect(listBackups(join(makeTempDir(), "nope"))).toEqual([]);
	});

	it("lists newest-first with parsed metadata, omitting it when the sidecar is absent", () => {
		const backupDir = join(makeTempDir(), "backups");
		dropBackupFile(backupDir, "20260101_090000", true);
		dropBackupFile(backupDir, "20260301_090000", false);
		// A non-matching file is ignored.
		writeFileSync(join(backupDir, "unrelated.txt"), "x");

		const listed = listBackups(backupDir);
		expect(listed.map(entry => entry.name)).toEqual([
			"mnemopi_backup_20260301_090000.db.gz",
			"mnemopi_backup_20260101_090000.db.gz",
		]);
		expect(listed[0]?.metadata).toBeUndefined();
		expect(listed[1]?.metadata?.timestamp).toBe("20260101_090000");
		expect(listed[1]?.metadata?.compressed).toBe(true);
		expect(listed[1]?.size).toBeGreaterThan(0);
		expect(typeof listed[1]?.modified).toBe("string");
	});
});

describe("rotateBackups", () => {
	it("deletes the oldest beyond the keep count, with their metadata sidecars", () => {
		const backupDir = join(makeTempDir(), "backups");
		for (const stamp of ["20260101_090000", "20260201_090000", "20260301_090000", "20260401_090000"]) {
			dropBackupFile(backupDir, stamp, true);
		}
		const result = rotateBackups(backupDir, 2);
		expect(result.total_backups).toBe(4);
		expect(result.kept).toBe(2);
		expect(result.deleted).toBe(2);
		expect(result.deleted_files).toEqual([
			"mnemopi_backup_20260101_090000.db.gz",
			"mnemopi_backup_20260201_090000.db.gz",
		]);
		// The two oldest and their sidecars are gone; the two newest remain.
		expect(existsSync(join(backupDir, "mnemopi_backup_20260101_090000.db.gz"))).toBe(false);
		expect(existsSync(join(backupDir, "mnemopi_backup_20260101_090000.db.gz.json"))).toBe(false);
		expect(existsSync(join(backupDir, "mnemopi_backup_20260401_090000.db.gz"))).toBe(true);
	});

	it("deletes nothing when the count is at or under keep", () => {
		const backupDir = join(makeTempDir(), "backups");
		dropBackupFile(backupDir, "20260101_090000", true);
		const result = rotateBackups(backupDir, 10);
		expect(result).toEqual({ total_backups: 1, kept: 10, deleted: 0, deleted_files: [] });
	});

	it("reports zero totals for a missing directory", () => {
		expect(rotateBackups(join(makeTempDir(), "gone"), 3)).toEqual({
			total_backups: 0,
			kept: 3,
			deleted: 0,
			deleted_files: [],
		});
	});
});

describe("healthCheck", () => {
	it("reports healthy with the latest backup when the db is valid", () => {
		const dir = makeTempDir();
		const dataDir = join(dir, "data");
		const backupDir = join(dir, "backups");
		mkdirSync(dataDir, { recursive: true });
		createSqliteDb(join(dataDir, "mnemopi.db"));
		dropBackupFile(backupDir, "20260101_090000", true);
		dropBackupFile(backupDir, "20260301_090000", true);

		const result = withEnv({ MNEMOPI_DATA_DIR: dataDir, MNEMOPI_BACKUP_DIR: backupDir }, () => healthCheck());
		expect(result.status).toBe("healthy");
		expect(result.database.exists).toBe(true);
		expect(result.database.valid).toBe(true);
		expect(result.database.message).toBe("Database integrity verified");
		expect(result.backups.total).toBe(2);
		expect(result.backups.latest?.endsWith("mnemopi_backup_20260301_090000.db.gz")).toBe(true);
	});

	it("reports unhealthy when the database is missing", () => {
		const dir = makeTempDir();
		const dataDir = join(dir, "data");
		const backupDir = join(dir, "backups");
		mkdirSync(dataDir, { recursive: true });

		const result = withEnv({ MNEMOPI_DATA_DIR: dataDir, MNEMOPI_BACKUP_DIR: backupDir }, () => healthCheck());
		expect(result.status).toBe("unhealthy");
		expect(result.database.exists).toBe(false);
		expect(result.database.valid).toBe(false);
		expect(result.database.message).toBe("Database missing or corrupt");
		expect(result.backups.total).toBe(0);
		expect(result.backups.latest).toBeNull();
	});
});

describe("restore edge cases", () => {
	it("throws FileNotFoundError when the backup path is absent", () => {
		const dir = makeTempDir();
		expect(() => restoreBackup(join(dir, "missing.db.gz"), join(dir, "target.db"))).toThrow(FileNotFoundError);
	});

	it("throws FileNotFoundError when emergency restore finds no backups", () => {
		const dir = makeTempDir();
		expect(() => emergencyRestore(join(dir, "empty"), join(dir, "target.db"))).toThrow(FileNotFoundError);
	});

	it("returns false integrity for a missing database path", () => {
		expect(verifyIntegrity(join(makeTempDir(), "nope.db"))).toBe(false);
	});

	it("restores a gzipped SQL dump by replaying it into a fresh database", () => {
		const dir = makeTempDir();
		const targetPath = join(dir, "restored.db");
		const backupPath = join(dir, "dump_backup.db.gz");
		// A non-SQLite payload triggers the SQL-dump restore branch.
		const sql =
			"CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL);\nINSERT INTO memories (content) VALUES ('from dump');";
		writeFileSync(backupPath, gzipSync(Buffer.from(sql, "utf8")));

		const result = restoreBackup(backupPath, targetPath);
		expect(result.restored).toBe(true);
		expect(result.integrity_check).toBe(true);
		expect(readMemory(targetPath)).toBe("from dump");
	});

	it("emergency-restores from the newest valid backup, skipping a corrupt newer one", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);
		const good = createBackup(dbPath, backupDir);
		// A corrupt backup whose name sorts AFTER the good one, so it is tried first.
		writeCorruptSqliteBackup(join(backupDir, "mnemopi_backup_29991231_235959.db.gz"));

		const result = emergencyRestore(backupDir, join(dir, "restored.db"));
		expect(result.restored).toBe(true);
		expect(result.backup_used).toBe(good.backup_path);
		expect(result.attempts).toBe(2);
	});
});
