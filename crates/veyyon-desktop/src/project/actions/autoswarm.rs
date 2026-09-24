//! What a change to the autoswarm console asks the host for.
//!
//! The console belongs to the session whose command opened it, so every
//! request names that session: a window on no session has no console open and
//! sends nothing. Nothing is decided here beyond which session is named — the
//! row, the action and the preset travel as the console stated them, and the
//! host answers with the console as it stands.

use veyyon_desktop_model::{AutoswarmRequest, HostAction, SessionId};
use veyyon_desktop_surface::Intent;

/// The actions one console intent asks for, or `None` for an intent this
/// module does not own.
pub(super) fn autoswarm_actions(
	intent: &Intent,
	active: Option<SessionId>,
) -> Option<Vec<HostAction>> {
	let Some(session) = active else {
		return owned(intent).then(Vec::new);
	};
	let request = match intent {
		Intent::SetAutoswarmField { field, text, number, on } => {
			AutoswarmRequest::SetAutoswarmField {
				session,
				field: field.clone(),
				text: text.clone(),
				number: *number,
				on: *on,
			}
		},
		Intent::RunAutoswarmAction(action) => {
			AutoswarmRequest::RunAutoswarmAction { session, action: *action }
		},
		Intent::SaveAutoswarmPreset(name) => {
			AutoswarmRequest::SaveAutoswarmPreset { session, name: name.clone() }
		},
		Intent::DeleteAutoswarmPreset => AutoswarmRequest::DeleteAutoswarmPreset { session },
		Intent::CloseAutoswarmConsole => AutoswarmRequest::CloseAutoswarmConsole { session },
		_ => return None,
	};
	Some(vec![HostAction::Autoswarm(request)])
}

/// Whether this module owns the intent, for a window on no session: an intent
/// it owns asks for nothing, and one it does not is left to the tables after
/// it.
const fn owned(intent: &Intent) -> bool {
	matches!(
		intent,
		Intent::SetAutoswarmField { .. }
			| Intent::RunAutoswarmAction(_)
			| Intent::SaveAutoswarmPreset(_)
			| Intent::DeleteAutoswarmPreset
			| Intent::CloseAutoswarmConsole
	)
}
