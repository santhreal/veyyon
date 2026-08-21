import type { TAB_REQUIRED_ARGUMENTS } from "@veyyon/coding-agent/tools/browser/tab-api-guard";
import type { TabApi } from "@veyyon/coding-agent/tools/browser/tab-worker";

// A tab method that cannot be called with no arguments at all must be listed in
// TAB_REQUIRED_ARGUMENTS, or a caller that omits the argument crashes several
// frames deep — on `selector.trim()` for a selector, on a property of an
// undefined drag target for an object — instead of being told which argument is
// missing. This pairing is what makes the guard fail by default: adding such a
// method without a row in the table fails `bun check` here, at the declaration,
// rather than in a session months later.

/** True when the call cannot be made with no arguments at all. */
type NeedsAnArgument<F> = F extends (...args: infer A) => unknown ? ([] extends A ? false : true) : false;

type MethodsThatNeedAnArgument = {
	[K in keyof TabApi]-?: NeedsAnArgument<TabApi[K]> extends true ? K : never;
}[keyof TabApi];

type Guarded = keyof typeof TAB_REQUIRED_ARGUMENTS;

// Every method that needs an argument is guarded. An unguarded one surfaces as
// its own name in the error, which is what names the omission.
type Unguarded = Exclude<MethodsThatNeedAnArgument, Guarded>;
const _noUnguardedMethod: Unguarded extends never ? true : Unguarded = true;

// Every guarded name is a real method, so a rename cannot leave a dead row
// behind that guards nothing.
type Phantom = Exclude<Guarded, keyof TabApi>;
const _noPhantomRow: Phantom extends never ? true : Phantom = true;

void _noUnguardedMethod;
void _noPhantomRow;
