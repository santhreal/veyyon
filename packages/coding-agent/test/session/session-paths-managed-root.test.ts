import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir, resolveManagedSessionRoot } from "@veyyon/coding-agent/session/session-paths";
import type { SessionStorage } from "@veyyon/coding-agent/session/session-storage";

/**
 * resolveManagedSessionRoot decides whether a session directory is one veyyon itself laid out for a
 * given cwd, and if so returns its parent (the sessions root). It is the guard that lets root-relative
 * cleanup and enumeration act on managed layouts only, so it must accept EXACTLY the directory
 * computeDefaultSessionDir produces for that cwd and reject anything else.
 *
 * These tests exercise the real A->B pair (computeDefaultSessionDir -> resolveManagedSessionRoot)
 * rather than hand-encoding the directory name, so the encoder and the matcher are proven to agree:
 *   - the directory computed for a cwd round-trips back to the exact sessions root it was created under;
 *   - a sibling directory with an unrelated name under the same root is NOT treated as managed
 *     (returns undefined), so unrelated directories are never mistaken for a managed layout;
 *   - the managed directory for one cwd is not accepted when resolved against a DIFFERENT cwd, because
 *     the encoded name is cwd-specific.
 * A regression that loosened the name comparison would hand back a root for an unmanaged directory
 * (over-broad cleanup); one that tightened it would strand real managed sessions as unrecognized.
 */
describe("resolveManagedSessionRoot", () => {
	const roots: string[] = [];
	const storage: Pick<SessionStorage, "ensureDirSync"> = {
		ensureDirSync: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
	};

	function tempRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-managed-root-"));
		roots.push(root);
		return root;
	}

	afterEach(() => {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it("round-trips the directory computed for a cwd back to its sessions root", () => {
		const root = tempRoot();
		const cwd = path.join(os.homedir(), "projects", "managed-root-roundtrip");

		const sessionDir = computeDefaultSessionDir(cwd, storage as SessionStorage, root);

		// The computed directory lives directly under the sessions root...
		expect(path.dirname(sessionDir)).toBe(root);
		// ...and the matcher recognizes it and returns that exact root.
		expect(resolveManagedSessionRoot(sessionDir, cwd)).toBe(root);
	});

	it("returns undefined for a sibling directory whose name is not the encoded name", () => {
		const root = tempRoot();
		const cwd = path.join(os.homedir(), "projects", "managed-root-sibling");
		// Create the real managed dir so the root is populated, then probe an unrelated sibling.
		computeDefaultSessionDir(cwd, storage as SessionStorage, root);

		expect(resolveManagedSessionRoot(path.join(root, "not-the-encoded-name"), cwd)).toBeUndefined();
	});

	it("returns undefined when the directory belongs to a different cwd", () => {
		const root = tempRoot();
		const cwd = path.join(os.homedir(), "projects", "managed-root-owner");
		const otherCwd = path.join(os.homedir(), "projects", "managed-root-other");

		const sessionDir = computeDefaultSessionDir(cwd, storage as SessionStorage, root);

		// The encoded directory name is cwd-specific, so resolving it against another cwd rejects it.
		expect(resolveManagedSessionRoot(sessionDir, otherCwd)).toBeUndefined();
	});
});
