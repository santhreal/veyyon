/**
 * The ownership receipt install.sh writes beside every file it installs, and the
 * temp shapes it must never leave behind. Shared by the installer suites so one
 * contract is expressed once instead of drifting into two spellings.
 *
 * The receipt is a sidecar named `.<basename>.veyyon-owner`. It exists so
 * uninstall can tell a file this installer put somewhere from an unrelated file
 * that happens to have the same name, and it is load-bearing rather than
 * incidental:
 *
 *   - `mark_artifact_owned` writes one for the binary, each completion file, each
 *     alias completion file, and the source launcher.
 *   - `do_uninstall` refuses to remove a binary or a completion that has no
 *     receipt (`binary_artifact_is_ours`, `completion_artifact_is_ours`), so a
 *     missing receipt is a file the user is left to delete by hand.
 *   - `finalize_binary` treats a receipt it could not write as fatal.
 *
 * So a finished install MUST leave one beside each artifact, and a test that
 * demands a clean directory has to assert the receipt is there rather than assert
 * it away. That is the mistake this module exists to stop repeating: several
 * suites originally asserted "no dot-file beside the artifact", which was true
 * before receipts existed and afterwards demanded a broken uninstall.
 *
 * WHAT THE BODY MEANS. A receipt vouches for a FILE, never for a path. The v1
 * body was the bare constant `veyyon-installer-v1`, so it said "this installer
 * owns whatever is at this path": deleting an installed binary by hand left the
 * sidecar behind, and the next unrelated file to take that name inherited the
 * ownership. v2 records the identity of the artifact it was written for, and is
 * accepted only while the artifact still matches:
 *
 *     veyyon-installer-v2
 *     <kind> sha256:<64 lowercase hex>
 *
 * `kind` is `file` for a regular file, identified by its bytes, or `link` for a
 * symlink, identified by the TARGET STRING it holds. install.sh, install.ps1 and
 * the self-updater's `restampOwnerReceipt` all write exactly these bytes, LF
 * terminated, so {@link ownerReceiptBodyFor} describes every platform.
 *
 * Temps are the separate contract. Every staged write in install.sh is
 * `.<name>.<pid>`, moved into place or removed by the EXIT/INT/TERM trap:
 * `staging_path` writes `.veyyon.{download,local}.<pid>`, `install_completions`
 * writes `.<completion name>.<pid>`, and `mark_artifact_owned` writes
 * `.<name>.veyyon-owner.<pid>`. None of the three may survive an install, whether
 * it finished or was interrupted. `halfWrittenTempsFor` is that check, and it
 * excludes the receipt by exact name rather than by loosening the pattern.
 *
 * `scripts/installer-environment-matrix.test.ts` keeps the guard that reads the
 * suffix and the body shape back out of install.sh, so renaming either one in the
 * installer fails a test instead of leaving these constants pointed at a name
 * nothing writes.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Suffix of the sidecar, per install.sh's `owner_marker_for`. */
export const OWNER_RECEIPT_SUFFIX = ".veyyon-owner";

/** First line of a receipt that records a file identity, per `mark_artifact_owned`. */
export const OWNER_RECEIPT_VERSION = "veyyon-installer-v2";

/**
 * The pre-identity receipt body, written by installers up to v1.0.46.
 *
 * Kept because it is a real state on real disks and the suites have to seed it:
 * it is what an orphaned receipt looks like, and it is what an install predating
 * this change left behind. It is NOT what the installer writes any more, and
 * `artifact_has_owner_receipt` rejects it.
 */
export const LEGACY_OWNER_RECEIPT_BODY = "veyyon-installer-v1\n";

/** The receipt path install.sh's `owner_marker_for` produces for `artifact`. */
export function ownerReceiptFor(artifact: string): string {
	return path.join(path.dirname(artifact), `.${path.basename(artifact)}${OWNER_RECEIPT_SUFFIX}`);
}

/**
 * The identity line install.sh's `artifact_identity` computes for whatever is at
 * `artifact` right now.
 *
 * A symlink is identified by the target string it holds, never by the bytes it
 * resolves to, which is why this reads the link rather than following it. Uses
 * `lstat` for the same reason: following would identify a dangling source
 * launcher as missing rather than as the link it is.
 */
export function artifactIdentityFor(artifact: string): string {
	const stat = fs.lstatSync(artifact);
	const [kind, bytes] = stat.isSymbolicLink()
		? (["link", Buffer.from(fs.readlinkSync(artifact))] as const)
		: (["file", fs.readFileSync(artifact)] as const);
	return `${kind} sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Exactly what `mark_artifact_owned` writes for `artifact`, including the
 * trailing newline.
 *
 * Takes the artifact rather than being a constant because that is the whole
 * point of v2: the body is a function of the file, so a test that pins it also
 * pins that the receipt describes the file actually on disk. A suite asserting
 * this after an update is asserting that the updater re-stamped.
 */
export function ownerReceiptBodyFor(artifact: string): string {
	return `${OWNER_RECEIPT_VERSION}\n${artifactIdentityFor(artifact)}\n`;
}

/**
 * Write the receipt install.sh would have written for `artifact`, and return its
 * path. For fixtures that need a file the installer already owns, so a test never
 * has to hand-build the identity that `artifact_has_owner_receipt` recomputes.
 */
export function writeOwnerReceipt(artifact: string): string {
	const receipt = ownerReceiptFor(artifact);
	fs.writeFileSync(receipt, ownerReceiptBodyFor(artifact));
	return receipt;
}

/**
 * Write the pre-identity receipt an installer up to v1.0.46 left beside
 * `artifact`, and return its path. For fixtures modelling an install that
 * predates recorded identity, or the orphan that receipt permits.
 */
export function writeLegacyOwnerReceipt(artifact: string): string {
	const receipt = ownerReceiptFor(artifact);
	fs.writeFileSync(receipt, LEGACY_OWNER_RECEIPT_BODY);
	return receipt;
}

/**
 * Names beside `artifact` that are half-written installer temps.
 *
 * Every `.<basename>.` sibling is a temp the installer failed to move or clean
 * up, with one exception: the durable ownership receipt, which is excluded by its
 * exact name. Assert the receipt separately, never by widening this filter.
 */
export function halfWrittenTempsFor(artifact: string): string[] {
	const dir = path.dirname(artifact);
	const receipt = path.basename(ownerReceiptFor(artifact));
	return fs.readdirSync(dir).filter(name => name.startsWith(`.${path.basename(artifact)}.`) && name !== receipt);
}

/**
 * The provisional receipt path the installers and the updater write BEFORE they
 * move a binary into place: the durable receipt's name plus `.pending`.
 *
 * Mirrors `owner_pending_marker_for` in scripts/install.sh,
 * `Get-PendingOwnerMarkerPath` in scripts/install.ps1, and
 * `pendingOwnerReceiptPathFor` in packages/coding-agent/src/cli/update-cli.ts.
 */
export function pendingOwnerReceiptFor(artifact: string): string {
	return `${ownerReceiptFor(artifact)}.pending`;
}

/**
 * Write a pending receipt naming `identity` beside `artifact`, and return its
 * path.
 *
 * `identity` is the identity of the bytes that were ABOUT to be installed, which
 * is the whole point of the fixture: a pending receipt naming the file that is
 * there now models a swap interrupted after the rename, and one naming something
 * else models a swap interrupted before it.
 */
export function writePendingOwnerReceipt(artifact: string, identity: string): string {
	const receipt = pendingOwnerReceiptFor(artifact);
	fs.writeFileSync(receipt, `${OWNER_RECEIPT_VERSION}\n${identity}\n`);
	return receipt;
}
