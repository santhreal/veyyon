//! What a snapshot announces about a session the operator is not looking at.
//!
//! A decision is answered above the composer of the session it belongs to, so
//! one raised on any other session changes nothing on screen. The announcement
//! stack is where it is stated instead, and the key every card carries is
//! built here, so the card a decision raises and the cards a session opening
//! takes down are named the same way.

use std::collections::BTreeSet;

use crate::{
	InteractionId, Notification, NotificationPriority, NotificationQueue, NotificationSource,
	PendingDecisions, SessionId,
};

/// The prefix every announcement about one session's decisions shares.
pub(super) fn decision_prefix(session: &SessionId) -> String {
	format!("decision-waiting:{}:", session.0)
}

pub(super) fn decision_ids(pending: &PendingDecisions) -> impl Iterator<Item = InteractionId> + '_ {
	pending
		.approvals
		.iter()
		.map(|a| a.id.clone())
		.chain(pending.questions.iter().map(|q| q.id.clone()))
		.chain(pending.plans.iter().map(|p| p.id.clone()))
}

/// The key every announcement about one session's decision shares, so a
/// decision is announced once and one session's cards come down together.
fn decision_key(session: &SessionId, decision: &InteractionId) -> String {
	format!("{}{}", decision_prefix(session), decision.0)
}

/// Announces every decision this snapshot raised on a session that is not the
/// open one.
///
/// The card that states a decision is drawn above that session's composer, so
/// a decision on any other session changes nothing on screen while the turn it
/// belongs to waits for an answer. A decision already pending before the
/// snapshot is not announced again: the set it arrived in is compared with the
/// set that was there, so a snapshot restating what is pending raises nothing.
pub(super) fn announce_decisions_out_of_view(
	store: &mut NotificationQueue,
	session: &SessionId,
	previous: Option<&PendingDecisions>,
	pending: Option<&PendingDecisions>,
) {
	let held: BTreeSet<InteractionId> = previous.into_iter().flat_map(decision_ids).collect();
	let waiting: BTreeSet<InteractionId> = pending.into_iter().flat_map(decision_ids).collect();
	// A decision that has been answered is not waiting on anything, so its
	// card goes with it. An urgent announcement never expires on a clock,
	// which is exactly why this is the only thing that takes it down.
	for answered in held.difference(&waiting) {
		store.dismiss(&decision_key(session, answered));
	}
	for decision in pending.into_iter().flat_map(decision_waits) {
		if held.contains(&decision.0) {
			continue;
		}
		store.raise(Notification {
			key:          decision_key(session, &decision.0),
			source:       NotificationSource::DecisionWaiting,
			priority:     NotificationPriority::Urgent,
			title:        decision.1,
			detail:       Some(decision.2),
			raised_at_ms: decision.3,
		});
	}
}

/// Every pending decision as the announcement it would be made: its id, the
/// line that states it, what kind of answer it is waiting for, and the moment
/// the host reported it was raised.
fn decision_waits(
	pending: &PendingDecisions,
) -> impl Iterator<Item = (InteractionId, String, String, u64)> + '_ {
	pending
		.approvals
		.iter()
		.map(|ask| {
			(
				ask.id.clone(),
				format!("{} is waiting for approval", ask.tool_name),
				"approval".to_owned(),
				ask.requested_at_ms,
			)
		})
		.chain(pending.questions.iter().map(|ask| {
			(ask.id.clone(), ask.prompt.clone(), "question".to_owned(), ask.requested_at_ms)
		}))
		.chain(pending.plans.iter().map(|ask| {
			(
				ask.id.clone(),
				"A plan is waiting for review".to_owned(),
				"plan".to_owned(),
				ask.requested_at_ms,
			)
		}))
}
