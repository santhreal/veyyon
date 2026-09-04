import type { ExtensionAPI, ExtensionContext } from "../extensibility/extensions";
import type { AutoresearchRuntime } from "./types";

/** `a0`, `a1`, … as the loop and the storage rows spell an arm. */
const ARM_ID = /^a(\d+)$/;

export interface ArmSwitch {
	ok: true;
	/** What the arm builds on now. */
	modelLabel: string;
	/** Whether the session model changed, false when the arm keeps it. */
	switched: boolean;
}

export interface ArmSwitchFailure {
	ok: false;
	error: string;
}

/** What leaving an arm did to the session model. */
export interface ArmExit {
	/** Whether the session was put back on the model the arm switched away from. */
	restored: boolean;
	/**
	 * The arm model the session is still on because the restore was refused, or
	 * null when nothing was stranded. A stranded exit keeps `activeArm`, so a
	 * later leave retries it.
	 */
	strandedOn: string | null;
}

/** Arm index from its id, or null when the id is not `a<N>`. */
export function armIndex(arm: string): number | null {
	const match = ARM_ID.exec(arm.trim());
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

/**
 * Put the session on the model configured for `arm` and remember what to return
 * to.
 *
 * An arm is built by the session model itself rather than by a subagent, so the
 * only way one arm can differ from another in model is to switch the session
 * between them. The switch is announced rather than inferred: nothing else in
 * the loop knows which arm the next edit belongs to.
 *
 * A spec that resolves to nothing fails the call instead of falling back to the
 * session model. The comparison the row was configured to make is between two
 * named models, and an arm that silently ran on the wrong one produces a result
 * that reads as a model comparison and is not one.
 */
export async function enterArm(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: AutoresearchRuntime,
	arm: string,
	spec: string | undefined,
): Promise<ArmSwitch | ArmSwitchFailure> {
	// A previous arm left the session on its model. Restore before switching, so
	// the arm that runs on the session model gets the session model rather than
	// whatever the arm before it happened to use.
	await leaveArm(pi, runtime);
	// A refused restore keeps the arm in place, and its restore target is still
	// the session's own model. Carry that, so a chain of arms returns to the
	// session model rather than to whichever arm the refusal stranded it on.
	const stranded = runtime.activeArm;
	const current = stranded?.restore ?? ctx.models.current();
	if (spec === undefined || spec.length === 0) {
		// This arm builds on the session model, so the session has to be on it. A
		// refusal above means it is not, and an arm on the wrong model reports a
		// comparison it did not make.
		if (stranded?.restore && !(await pi.setModel(stranded.restore))) {
			return {
				ok: false,
				error: `Failed to return to "${stranded.restore.name}" for ${arm}. The session is still on ${stranded.modelLabel}.`,
			};
		}
		runtime.activeArm = { arm, modelLabel: current?.name ?? "the session model", restore: undefined };
		return { ok: true, modelLabel: runtime.activeArm.modelLabel, switched: false };
	}
	const target = ctx.models.resolve(spec);
	if (!target) {
		return {
			ok: false,
			error: `No authenticated model matches "${spec}", configured for ${arm}. Reconfigure the arm models in /autoswarm, or authenticate that provider.`,
		};
	}
	if (!stranded && current && target.id === current.id && target.api === current.api) {
		runtime.activeArm = { arm, modelLabel: target.name, restore: undefined };
		return { ok: true, modelLabel: target.name, switched: false };
	}
	if (!(await pi.setModel(target))) {
		return { ok: false, error: `Failed to switch to "${spec}" for ${arm}. The session model is unchanged.` };
	}
	// Nothing to return to when the arm's model is the session's own, even though
	// a stranded session had to be switched onto it.
	const sameAsSession = current && target.id === current.id && target.api === current.api;
	runtime.activeArm = { arm, modelLabel: target.name, restore: sameAsSession ? undefined : current };
	return { ok: true, modelLabel: target.name, switched: true };
}

/**
 * Return the session to the model it was on before the active arm, and report
 * whether anything changed.
 *
 * Called wherever an arm ends: its logged result, the mode being turned off, a
 * cleared session. The loop's own reasoning — triage, certification, choosing
 * the next hypothesis — belongs to the session model, not to whichever arm ran
 * last, and a user who leaves mid-arm gets their model back rather than
 * discovering it days later in the model row.
 *
 * A refused restore is reported rather than recorded as done: `setModel` answers
 * false when the model has no key, which a session can lose mid-run.
 */
export async function leaveArm(pi: ExtensionAPI, runtime: AutoresearchRuntime): Promise<ArmExit> {
	const active = runtime.activeArm;
	if (!active?.restore) {
		runtime.activeArm = null;
		return { restored: false, strandedOn: null };
	}
	if (!(await pi.setModel(active.restore))) {
		// Keep the arm: the status row still names the model the session is on, a
		// later leave retries, and no caller reads a restore that did not happen.
		return { restored: false, strandedOn: active.modelLabel };
	}
	runtime.activeArm = null;
	return { restored: true, strandedOn: null };
}
