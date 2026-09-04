/**
 * Parse a `sha256sum`-style checksum sidecar (`<64-hex>  <filename>`) to its
 * lowercased hex digest, or `null` when the text holds no valid digest.
 *
 * Every download veyyon performs is checked against a published `.sha256`
 * sidecar, and every one of those readers must agree on what counts as a
 * digest. This is the one place that decides, shared by the self-updater and by
 * the native-addon provisioning that runs during a source install. It lives in
 * this package because it is the lowest layer both of them already depend on.
 * The shell installers cannot import it (`install.sh` uses `awk '{print $1}'`,
 * `install.ps1` uses `ConvertFrom-Sha256Sidecar`) and are held to the same
 * behavior by tests instead.
 *
 * Strict on purpose. A token that is not exactly 64 hex characters means the
 * sidecar is not a checksum at all: a truncated file, an HTML error page, a
 * rate-limit body, an empty response. Returning `null` there makes callers fail
 * closed and say the sidecar is unusable. Passing the token through instead
 * would compare the real digest against `<!doctype` and report a checksum
 * mismatch, which tells the user their download is corrupt when the download
 * was fine and the sidecar was not.
 */
export function parseSha256Sidecar(text: string): string | null {
	const token = text.trim().split(/\s+/)[0] ?? "";
	return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}
