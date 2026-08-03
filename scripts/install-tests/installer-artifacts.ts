/**
 * The ownership receipt install.sh writes beside every file it installs, and the
 * temp shapes it must never leave behind. Shared by the installer suites so one
 * contract is expressed once instead of drifting into two spellings.
 *
 * The receipt is a sidecar named `.<basename>.veyyon-owner` holding one line,
 * `veyyon-installer-v1`. It exists so uninstall can tell a file this installer
 * put somewhere from an unrelated file that happens to have the same name, and it
 * is load-bearing rather than incidental:
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
 * Temps are the separate contract. Every staged write in install.sh is
 * `.<name>.<pid>`, moved into place or removed by the EXIT/INT/TERM trap:
 * `staging_path` writes `.veyyon.{download,local}.<pid>`, `install_completions`
 * writes `.<completion name>.<pid>`, and `mark_artifact_owned` writes
 * `.<name>.veyyon-owner.<pid>`. None of the three may survive an install, whether
 * it finished or was interrupted. `halfWrittenTempsFor` is that check, and it
 * excludes the receipt by exact name rather than by loosening the pattern.
 *
 * `scripts/installer-environment-matrix.test.ts` keeps the guard that reads the
 * suffix and the body back out of install.sh, so renaming either one in the
 * installer fails a test instead of leaving these constants pointed at a name
 * nothing writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Suffix of the sidecar, per install.sh's `owner_marker_for`. */
export const OWNER_RECEIPT_SUFFIX = ".veyyon-owner";

/** Exactly what `mark_artifact_owned` writes, including its trailing newline. */
export const OWNER_RECEIPT_BODY = "veyyon-installer-v1\n";

/** The receipt path install.sh's `owner_marker_for` produces for `artifact`. */
export function ownerReceiptFor(artifact: string): string {
	return path.join(path.dirname(artifact), `.${path.basename(artifact)}${OWNER_RECEIPT_SUFFIX}`);
}

/**
 * Write the receipt install.sh would have written for `artifact`, and return its
 * path. For fixtures that need a file the installer already owns, so a test never
 * has to hand-copy the token that `artifact_has_owner_receipt` greps for.
 */
export function writeOwnerReceipt(artifact: string): string {
	const receipt = ownerReceiptFor(artifact);
	fs.writeFileSync(receipt, OWNER_RECEIPT_BODY);
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
