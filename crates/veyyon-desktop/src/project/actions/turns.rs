//! What the turn in front of the operator asks the host for.
//!
//! These are the composer's own asks, each naming the open session: sending a
//! prompt, steering one that is running, queueing one behind it, stopping it,
//! moving the command it is waiting on to a background job, and taking back
//! the prompt queued behind it. A window with no session open sends none of
//! them.

use veyyon_desktop_model::{HostAction, SessionId};
use veyyon_desktop_surface::Intent;

use crate::project::submission::submission_of;

/// The actions one composer intent asks for, or `None` for an intent this
/// module does not own.
pub(super) fn turn_actions(intent: &Intent, active: Option<SessionId>) -> Option<Vec<HostAction>> {
	let actions = match intent {
		Intent::Send { text, attachments } => active.map_or_else(Vec::new, |session| {
			vec![HostAction::SubmitPrompt {
				session,
				text: text.clone(),
				attachments: attachments.iter().enumerate().map(submission_of).collect(),
			}]
		}),
		Intent::Steer(text) => active
			.map_or_else(Vec::new, |session| vec![HostAction::Steer { session, text: text.clone() }]),
		Intent::Queue(text) => active.map_or_else(Vec::new, |session| {
			vec![HostAction::FollowUp { session, text: text.clone() }]
		}),
		Intent::AbortTurn => {
			active.map_or_else(Vec::new, |session| vec![HostAction::AbortTurn { session }])
		},
		// The command the turn is waiting on is the bash tool's, and the
		// session it runs in is what the host resolves the wait by, so the
		// window names its own session and nothing else.
		Intent::BackgroundCommand => {
			active.map_or_else(Vec::new, |session| vec![HostAction::BackgroundCommand { session }])
		},
		Intent::DequeueQueuedPrompt => {
			active.map_or_else(Vec::new, |session| vec![HostAction::DequeueQueuedPrompt { session }])
		},
		_ => return None,
	};
	Some(actions)
}
