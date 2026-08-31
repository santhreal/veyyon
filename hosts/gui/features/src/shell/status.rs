//! What the window says about its connection to a host, in one place.
//!
//! The titlebar states the connection and nothing else does. Before this
//! existed the mapping was written three times — the titlebar, the route strip
//! and the conversation strip — and the three disagreed: connecting was muted
//! in one and a warning in another, and syncing carried a count in one and not
//! the others. A reader saw two chips of the same fact side by side, in two
//! colours.
//!
//! WHY THE TITLEBAR OWNS IT. It is the one strip on screen in every route, in
//! every panel arrangement, so a state that reaches it reaches the reader once.
//! A route strip is beside content that already says what it could not load.

use gpui::SharedString;
use veyyon_gui_core::{UiCommand, model::ConnectionState};
use veyyon_gui_kit::ui::Tone;

/// What a connection state is called, how it is coloured, and what a press on
/// it does.
///
/// `Some(command)` makes the chip the affordance: detached and unavailable are
/// the two states a reader is expected to act on, and they are the two states
/// in which every other route offers no button at all.
pub struct Connection {
	pub label:  SharedString,
	pub tone:   Tone,
	pub action: Option<(&'static str, UiCommand)>,
}

pub fn connection(state: &ConnectionState) -> Connection {
	match state {
		ConnectionState::Detached => Connection {
			label:  "Detached".into(),
			tone:   Tone::Muted,
			action: Some(("Attach a host", UiCommand::Attach { endpoint: None })),
		},
		ConnectionState::Connecting { attempt } => Connection {
			label:  format!("Connecting · attempt {attempt}").into(),
			tone:   Tone::Warn,
			action: None,
		},
		ConnectionState::Syncing { received, expected } => Connection {
			label:  expected
				.map_or_else(
					|| format!("Syncing · {received}"),
					|expected| format!("Syncing · {received}/{expected}"),
				)
				.into(),
			tone:   Tone::Warn,
			action: None,
		},
		ConnectionState::Connected { .. } => {
			Connection { label: "Connected".into(), tone: Tone::Ok, action: None }
		},
		ConnectionState::Reconnecting { attempt, .. } => Connection {
			label:  format!("Reconnecting · attempt {attempt}").into(),
			tone:   Tone::Warn,
			action: Some(("Retry now", UiCommand::RetryConnection)),
		},
		ConnectionState::Fatal { .. } => Connection {
			label:  "Unavailable".into(),
			tone:   Tone::Danger,
			action: Some(("Retry the connection", UiCommand::RetryConnection)),
		},
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. The mapping used to be three copies that
	//! disagreed, and the failure was invisible: two chips of one fact, in two
	//! colours, in one window. The match is exhaustive, so a new state compiles
	//! only once it is named here; these assert the two properties a reader
	//! depends on.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the titlebar draws it. The captured
	//! frames are the evidence for that.

	use super::*;

	fn states() -> Vec<ConnectionState> {
		vec![
			ConnectionState::Detached,
			ConnectionState::Connecting { attempt: 2 },
			ConnectionState::Syncing { received: 3, expected: Some(9) },
			ConnectionState::Syncing { received: 3, expected: None },
			ConnectionState::Connected { endpoint: "scene://host".to_owned(), protocol: 1 },
			ConnectionState::Reconnecting {
				attempt:     4,
				retry_at_ms: 1_800_000_000_000,
				message:     "dropped".to_owned(),
			},
			ConnectionState::Fatal { message: "no host".to_owned() },
		]
	}

	#[test]
	fn every_state_says_something_a_reader_can_read() {
		for state in states() {
			let shown = connection(&state);
			assert!(!shown.label.trim().is_empty(), "{state:?} has no label");
		}
	}

	#[test]
	fn only_the_states_a_reader_can_act_on_carry_an_action() {
		// A press on the chip is the one affordance that is on screen in every
		// route, so the states that offer it are exactly the states in which
		// the rest of the window offers nothing.
		let acting: Vec<String> = states()
			.into_iter()
			.filter(|state| connection(state).action.is_some())
			.map(|state| format!("{state:?}"))
			.collect();
		assert_eq!(acting, vec![
			"Detached".to_owned(),
			format!("{:?}", ConnectionState::Reconnecting {
				attempt:     4,
				retry_at_ms: 1_800_000_000_000,
				message:     "dropped".to_owned(),
			}),
			format!("{:?}", ConnectionState::Fatal { message: "no host".to_owned() }),
		]);
	}

	#[test]
	fn a_sync_states_how_far_it_has_got() {
		// The count is what distinguishes a sync that is moving from one that
		// has stopped, and it was the field the three copies disagreed on.
		let known = connection(&ConnectionState::Syncing { received: 3, expected: Some(9) });
		assert_eq!(known.label.as_ref(), "Syncing · 3/9");
		let unknown = connection(&ConnectionState::Syncing { received: 3, expected: None });
		assert_eq!(unknown.label.as_ref(), "Syncing · 3");
	}
}
