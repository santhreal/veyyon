//! The decisions attached above the composer, and the answer each one sends.

use serde_json::{Value, json};
use veyyon_desktop_model::{InteractionId, PendingDecisions};
use veyyon_desktop_surface::{Card, Intent};

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
		let mut lines = p.markdown_plan.lines();
		let title = lines
			.next()
			.unwrap_or_default()
			.trim_start_matches('#')
			.trim()
			.to_string();
		Card::Plan { title, body: lines.map(str::to_string).collect() }
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
		Intent::Plan { accepted, .. }
			if card >= approvals + questions && card - approvals - questions < pending.plans.len() =>
		{
			let plan = pending.plans.remove(card - approvals - questions);
			Some((plan.id, json!({ "accepted": accepted })))
		},
		_ => None,
	}
}
