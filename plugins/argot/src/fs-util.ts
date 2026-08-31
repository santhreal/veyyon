/** Shared filesystem helpers. */

/** Whether a caught error is a "file does not exist" (`ENOENT`) error. */
export function isNotFound(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}
