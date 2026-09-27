/**
 * The `type` parser the auth gateway's request schemas build with: bound to a scope that compiles
 * its validators even when the process configured ArkType jitless, as the CLI entry does.
 *
 * A gateway request schema checks a whole conversation on every request, and interpreted traversal
 * checks a 751-message chat-completions request in 2.1 ms against 42 µs compiled. The gateway loads
 * these schemas only when it serves, so their compile cost is off the launch path.
 */
import { scope } from "arktype";

export const { type } = scope({}, { jitless: false });
