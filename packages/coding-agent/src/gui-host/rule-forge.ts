/**
 * `/omfg`: a TTSR rule forged from a complaint, reviewed in the window.
 *
 * The forge itself is `rules/forge.ts`, which both hosts run. What a window
 * supplies is where the rule is put for review: the terminal draws a panel
 * with the draft streaming into it, and a window is asked on the interaction
 * ledger, so the rule arrives as a decision card with the same three answers
 * the panel offers — save it, amend it, or leave it.
 *
 * An amendment re-enters the forge with the feedback and the rule it is about,
 * so the next card carries a revision of the same rule rather than a fresh
 * attempt at the complaint.
 */
import { errorMessage } from "@veyyon/utils";
import { type ForgeCandidate, forgedRuleExists, forgedRuleTarget, forgeRule, saveForgedRule } from "../rules/forge";
import type { AgentSession } from "../session/agent-session";
import { shortenPath } from "../tools/core/render-utils";
import type { ActionContext } from "./actions/types";
import { appendCommandOutput } from "./command-output";

/** The answers the review card offers, in the order it offers them. */
const SAVE = "Save it";
const AMEND = "Amend it";
const DISCARD = "Discard it";

/** What a rule nobody could confirm is answered with. */
const SAVE_UNCONFIRMED = "Save anyway";

/** Runs the forge for `complaint`, replying to the request it arrived on. */
export async function forgeRuleForWindow(ctx: ActionContext, session: AgentSession, args: string): Promise<void> {
	const complaint = args.trim();
	const refuse = (code: string, message: string): void => {
		ctx.reply.failure({ scope: "Session", code, message, retryable: false });
	};
	if (!complaint) {
		refuse("INVALID_ARGUMENTS", "Usage: /omfg <complaint>");
		return;
	}
	if (!session.model) {
		refuse("NO_MODEL", "No active model is available to forge a rule with.");
		return;
	}
	const ledger = ctx.clientState.interactions;
	if (!ledger) {
		refuse("INVALID_ARGUMENTS", "This client answers no questions, so a rule cannot be reviewed here.");
		return;
	}

	let feedback: string | undefined;
	let previousRule: string | undefined;
	for (;;) {
		let candidate: ForgeCandidate | undefined;
		try {
			candidate = await forgeRule(session, complaint, { feedback, previousRule });
		} catch (error) {
			refuse("RULE_FORGE_FAILED", `The rule could not be forged: ${errorMessage(error)}`);
			return;
		}
		if (!candidate) {
			refuse("RULE_NOT_FORGED", "The model did not return a valid TTSR rule.");
			return;
		}

		if (!candidate.validated) {
			const anyway = await ledger.choice("Couldn't confirm this rule matches the conversation. Save it anyway?", [
				SAVE_UNCONFIRMED,
				DISCARD,
			]);
			if (anyway !== SAVE_UNCONFIRMED) {
				appendCommandOutput(ctx, "omfg", "The rule was not saved.");
				ctx.reply.success();
				return;
			}
		}

		const chosen = await ledger.choice(`Forged rule\n\n${candidate.fileContent}`, [SAVE, AMEND, DISCARD]);
		if (chosen === AMEND) {
			const amendment = (await ledger.text("Describe how to amend the rule"))?.trim();
			if (!amendment) {
				appendCommandOutput(ctx, "omfg", "The rule was not saved.");
				ctx.reply.success();
				return;
			}
			feedback = `An amendment was requested before saving:\n${amendment}`;
			previousRule = candidate.fileContent;
			continue;
		}
		if (chosen !== SAVE) {
			appendCommandOutput(ctx, "omfg", "The rule was not saved.");
			ctx.reply.success();
			return;
		}

		const agentDir = session.settings.getAgentDir();
		const target = forgedRuleTarget(agentDir, candidate.rule.name);
		if (await forgedRuleExists(target.filePath)) {
			const overwrite = await ledger.choice(`${shortenPath(target.filePath)} already exists. Overwrite it?`, [
				"Overwrite it",
				"Leave it",
			]);
			if (overwrite !== "Overwrite it") {
				appendCommandOutput(ctx, "omfg", "The rule was not saved.");
				ctx.reply.success();
				return;
			}
		}
		try {
			const filePath = await saveForgedRule(session, agentDir, candidate);
			appendCommandOutput(ctx, "omfg", `Saved ${shortenPath(filePath)}, live from the next turn.`);
		} catch (error) {
			refuse("RULE_NOT_SAVED", `The rule could not be written: ${errorMessage(error)}`);
			return;
		}
		ctx.reply.success();
		return;
	}
}
