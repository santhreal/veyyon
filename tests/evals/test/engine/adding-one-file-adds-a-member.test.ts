// WHY: adding a bench to this package used to mean writing the bench, exporting it
// from the directory's index, appending it to a `builtinX` array and remembering a
// `registerAll` call. Four edits for one addition, three of which are a second
// place the set of members is written down, and a forgotten index line makes the
// member silently absent — the exact failure explicit registration was supposed to
// prevent.
//
// The contract this defends: a member of any kind exists because a file exists in
// the directory named after its kind, and its id is its file name. No index, no
// barrel, no registration call.
//
// The class this closes: a discovery rule that works for the kinds that happen to
// exist today. Every case below sweeps `MEMBER_KINDS` at run time, so a new kind is
// covered the moment its row is added, and a kind whose directory is missing turns
// the sweep red rather than being skipped.
//
// What it does not catch: whether a discovered member satisfies its own kind's
// contract (a suite that lacks `scoreTrial` is that kind's own concern), and
// whether two kinds' directories overlap, which the filesystem prevents.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	findMembers,
	loadMembers,
	MEMBER_KINDS,
	type MemberKindName,
	PACKAGE_ROOT,
} from "../../engine/member-discovery";
import { DuplicateMemberError, MemberNotFoundError, Registry } from "../../engine/member-registry";

const KINDS = Object.keys(MEMBER_KINDS) as MemberKindName[];

async function scratchRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "evals-discover-"));
}

/** Writes a member file whose default export carries a marker the test can read. */
async function writeMember(root: string, kind: MemberKindName, file: string, body?: string): Promise<void> {
	const target = path.join(root, MEMBER_KINDS[kind].dir, file);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, body ?? `export default { marker: ${JSON.stringify(file)} };\n`, "utf-8");
}

describe("a member exists because its file exists", () => {
	it("declares a directory for every kind, and every one of them is present", async () => {
		// A kind whose directory is absent would discover nothing and report it as an
		// empty set, so the sweep below would pass while the kind was unreachable.
		expect(KINDS.length).toBeGreaterThan(0);
		const missing: string[] = [];
		for (const kind of KINDS) {
			const dir = path.join(PACKAGE_ROOT, MEMBER_KINDS[kind].dir);
			const stat = await fs.stat(dir).catch(() => null);
			if (!stat?.isDirectory()) missing.push(MEMBER_KINDS[kind].dir);
		}
		expect(missing).toEqual([]);
	});

	it("finds a file dropped into any kind's directory, with no index edited", async () => {
		for (const kind of KINDS) {
			const root = await scratchRoot();
			try {
				await writeMember(root, kind, "brand-new.ts");
				const found = await findMembers(kind, root);
				expect(found.map(member => member.id)).toEqual(["brand-new"]);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	});

	it("refuses a descriptor whose id disagrees with its file name, naming both", async () => {
		// One authority for an id, and it is the path. The descriptor is registered as
		// exported rather than copied under a corrected id, because copying drops the
		// methods of a class instance and most member descriptors are class instances.
		// So a disagreement is a refusal, not a silent correction that would leave the
		// file and the roster naming different things.
		const root = await scratchRoot();
		try {
			await writeMember(root, "suite", "true-name.ts", `export default { id: "a-lie", marker: "x" };\n`);
			const failure = await loadMembers("suite", root).catch((err: unknown) => err);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain(`"a-lie"`);
			expect((failure as Error).message).toContain(`"true-name"`);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("registers a descriptor under the id its path states", async () => {
		const root = await scratchRoot();
		try {
			await writeMember(root, "suite", "agreed.ts", `export default { id: "agreed", marker: "x" };\n`);
			const registry = await loadMembers<{ id: string; marker: string }>("suite", root);
			expect(registry.ids()).toEqual(["agreed"]);
			expect(registry.require("agreed").marker).toBe("x");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the methods of a class-instance descriptor", async () => {
		// Every real suite, harness and backend is a class instance. A loader that
		// copied the descriptor into a fresh object would return one whose prototype
		// methods are gone, and the first trial would fail on a missing scoreTrial
		// rather than at load.
		const root = await scratchRoot();
		try {
			await writeMember(
				root,
				"suite",
				"classy.ts",
				`class Member {\n\treadonly id = "classy";\n\tspeak(): string {\n\t\treturn "alive";\n\t}\n}\nexport default new Member();\n`,
			);
			const registry = await loadMembers<{ id: string; speak(): string }>("suite", root);
			expect(registry.require("classy").speak()).toBe("alive");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("enters a directory member through main.ts and names it for the directory", async () => {
		const root = await scratchRoot();
		try {
			await writeMember(root, "suite", path.join("big-member", "main.ts"));
			// A directory with no entry module is not a member, so a stray folder of
			// helpers cannot half-register itself.
			await writeMember(root, "suite", path.join("not-a-member", "helper.ts"));
			const found = await findMembers("suite", root);
			expect(found.map(member => member.id)).toEqual(["big-member"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("skips an underscore-prefixed name, so a shared file is not a member", async () => {
		const root = await scratchRoot();
		try {
			await writeMember(root, "bench", "_shared.ts");
			await writeMember(root, "bench", "real.ts");
			expect((await findMembers("bench", root)).map(member => member.id)).toEqual(["real"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a member with no default export, naming the file to open", async () => {
		const root = await scratchRoot();
		try {
			await writeMember(root, "suite", "forgot.ts", "export const notTheDefault = {};\n");
			const failure = await loadMembers("suite", root).catch((err: unknown) => err);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain(path.join("suites", "forgot.ts"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("returns no members for a kind whose directory is absent", async () => {
		const root = await scratchRoot();
		try {
			expect(await findMembers("measurement", root)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("orders members by id, so a listing does not depend on import resolution", async () => {
		const root = await scratchRoot();
		try {
			for (const name of ["zulu.ts", "alpha.ts", "mike.ts"]) await writeMember(root, "bench", name);
			expect((await findMembers("bench", root)).map(member => member.id)).toEqual(["alpha", "mike", "zulu"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("the registry keyed on id", () => {
	it("names the ids that exist when a lookup misses", () => {
		const registry = new Registry<{ id: string }>("bench");
		registry.register({ id: "search" });
		const failure = (() => {
			try {
				registry.require("serach");
				return null;
			} catch (err) {
				return err;
			}
		})();
		expect(failure).toBeInstanceOf(MemberNotFoundError);
		expect((failure as Error).message).toContain("search");
	});

	it("refuses two members claiming one id, and registerOnce does not", () => {
		const registry = new Registry<{ id: string }>("bench");
		registry.register({ id: "search" });
		expect(() => registry.register({ id: "search" })).toThrow(DuplicateMemberError);
		expect(() => registry.registerOnce({ id: "search" })).not.toThrow();
		expect(registry.ids()).toEqual(["search"]);
	});
});
