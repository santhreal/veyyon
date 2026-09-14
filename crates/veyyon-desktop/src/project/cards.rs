//! The decisions attached above the composer, and the answer each one sends.

use serde_json::{Value, json};
use veyyon_desktop_model::{InteractionId, PendingDecisions};
use veyyon_desktop_surface::{Card, Intent, plain_lines};

/// The cards for a session's pending decisions: approvals, then questions,
/// then plans. `interaction_at` reads the same order, so a card's position is
/// its interaction's.
pub(super) fn cards(pending: &PendingDecisions) -> Vec<Card> {
	let mut cards =
		Vec::with_capacity(pending.approvals.len() + pending.questions.len() + pending.plans.len());
	cards.extend(pending.approvals.iter().map(|a| Card::Approval {
		tool:   a.tool_name.clone(),
		detail: a.detail.lines().map(str::to_string).collect(),
	}));
	cards.extend(
		pending
			.questions
			.iter()
			.map(|q| Card::Question { prompt: q.prompt.clone(), options: q.options.clone() }),
	);
	cards.extend(pending.plans.iter().map(|p| {
		// A plan's first line with text on it names the plan, and the card
		// draws that name in its own ramp, so it is not redrawn in the body.
		// The run bar reads the same line, so the two name one plan once, and
		// the blank the heading was parted from is not drawn as an empty row.
		let lines = plain_lines(&p.markdown_plan);
		let named = lines.iter().position(|line| !line.trim().is_empty());
		let title = named.map_or_else(String::new, |at| lines[at].trim().to_owned());
		let rest = named.map_or(&[][..], |at| &lines[at + 1..]);
		let start = rest
			.iter()
			.position(|line| !line.trim().is_empty())
			.unwrap_or(rest.len());
		let end = rest
			.iter()
			.rposition(|line| !line.trim().is_empty())
			.map_or(start, |at| at + 1);
		Card::Plan { title, body: rest[start..end].to_vec() }
	}));
	cards
}

/// Removes and returns the interaction at a card position, with the answer
/// the host expects for it.
///
/// The card was removed from the shell state when the intent was applied, so
/// the store's copy is removed here to keep the two stacks aligned for the
/// next card answered before the host confirms this one.
pub(super) fn take_interaction(
	pending: &mut PendingDecisions,
	card: usize,
	answer: &Intent,
) -> Option<(InteractionId, Value)> {
	let approvals = pending.approvals.len();
	let questions = pending.questions.len();
	match *answer {
		Intent::Approval { approved, standing, .. } if card < approvals => {
			let approval = pending.approvals.remove(card);
			let scope = if standing { "session" } else { "once" };
			Some((approval.id, json!({ "approved": approved, "scope": scope })))
		},
		Intent::Answer { option, .. } if (approvals..approvals + questions).contains(&card) => {
			let question = pending.questions.remove(card - approvals);
			let text = question.options.get(option)?.clone();
			Some((question.id, json!({ "option": option, "text": text })))
		},
		Intent::Reply { ref text, .. } if (approvals..approvals + questions).contains(&card) => {
			let question = pending.questions.remove(card - approvals);
			Some((question.id, json!({ "text": text })))
		},
		Intent::Plan { accepted, ref feedback, .. }
			if card >= approvals + questions && card - approvals - questions < pending.plans.len() =>
		{
			let plan = pending.plans.remove(card - approvals - questions);
			Some((plan.id, json!({ "accepted": accepted, "feedback": feedback })))
		},
		_ => None,
	}
}
