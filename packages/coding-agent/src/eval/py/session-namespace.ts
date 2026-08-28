/** The `python:` namespace applied to eval session ids. A leaf beside `eval/backend-helpers`, which is itself a leaf, so a caller that only needs to */
import { namespaceSessionId as sharedNamespace } from "../backend-helpers";

/** The prefix every Python eval session id carries. */
export const PYTHON_SESSION_PREFIX = "python:";

/** Namespace `sessionId` into the Python eval backend's own id space. */
export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, PYTHON_SESSION_PREFIX);
}
