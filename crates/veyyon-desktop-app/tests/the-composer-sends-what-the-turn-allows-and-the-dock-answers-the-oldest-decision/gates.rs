//! The window opens with the keys in the composer when it draws one, and
//! nowhere a key can type or send from when it does not; and no composer
//! action sends a request the host withholds.
//!
//! WHY: the workspace focused its own root on the first frame, so a window
//! that opened on a thread took no typing until the composer was clicked.
//! Focus sent to a composer the frame does not draw (no session shown, or
//! settings in the thread's place) puts the keys in an editor that is not on
//! screen, typing a draft nobody sees and sending it with Enter. The sweep
//! reads the expectation off the window's state for every state of the
//! thread's place `column` reaches, so neither direction can be suppressed
//! alone. A control the host withholds is drawn idle, but its key, its
//! palette row and the recall key reached the host anyway: the chord flipped
//! the queue mode, Enter sent a prompt and a picker opened on rows nothing
//! could send. The second sweep dispatches every action registered under
//! `composer::`, read at run time, in an idle and a running thread, once per
//! capability the host can withhold, so an action added later is swept.
//!
//! Gap: where the keys go after the first frame (a region closing, a session
//! opening later) is the focus suite's; with no composer drawn the keys go
//! to the workspace, which this suite does not name. The actions are
//! dispatched over one draft with no decision waiting, so a command draft
//! and the answers to a decision are not swept here.

use std::collections::BTreeSet;

use gpui::{Action, TestAppContext};
use veyyon_desktop_model::{Capability, HostAction, action_to_capability};

use super::{
	Win, capability,
	column::{Column, columns, desk},
	footer::models,
	streamed, window,
};

/// What the draft holds when each action is dispatched.
const DRAFT: &str = "Tidy the tests";

/// The capabilities the composer's requests need while the host withholds
/// none: the sweep asserts each of these is held back when withheld.
const REACHED: [Capability; 10] = [
	Capability::Sessions,
	Capability::TurnControl,
	Capability::Approvals,
	Capability::Models,
	Capability::AgentCommands,
	Capability::Extensions,
	Capability::Goals,
	Capability::Dictation,
	Capability::PromptHistory,
	Capability::ForegroundCommand,
];

/// Every composer action, built from the name it is registered under.
fn composer_actions(w: &mut Win<'_>) -> Vec<Box<dyn Action>> {
	w.cx.update(|_, cx| {
		cx.all_action_names()
			.iter()
			.filter(|name| name.starts_with("composer::"))
			.map(|name| {
				cx.build_action(name, None)
					.unwrap_or_else(|error| panic!("{name} builds with no arguments: {error}"))
			})
			.collect()
	})
}

/// Every request the recall key on an empty draft and then each composer
/// action over [`DRAFT`] send, in a thread idle or `running` a turn, while
/// the host withholds `withheld`.
fn sent_by_every_action(withheld: Option<Capability>, running: bool) -> Vec<HostAction> {
	let mut app = TestAppContext::single();
	let mut events = vec![models("claude-sonnet-4.5", "high")];
	events.extend(running.then(|| streamed(2)));
	events.extend(withheld.map(|held| capability(held, Some("the host withholds it"))));
	let mut w = window(&mut app, events);
	w.focus();
	w.keys("up");
	let mut sent: Vec<HostAction> = w
		.drain()
		.into_iter()
		.map(|request| request.action)
		.collect();
	for action in composer_actions(&mut w) {
		w.write(DRAFT);
		w.cx.update(|window, cx| window.dispatch_action(action, cx));
		w.cx.run_until_parked();
		sent.extend(w.drain().into_iter().map(|request| request.action));
	}
	sent
}

/// The capabilities `sent` needs.
fn needs(sent: &[HostAction]) -> BTreeSet<Capability> {
	sent
		.iter()
		.map(|action| action_to_capability(action.kind()))
		.collect()
}

#[test]
fn the_first_frame_puts_the_keys_in_the_composer_exactly_when_it_draws_one() {
	for Column { name, store, events, settings } in columns() {
		let mut app = TestAppContext::single();
		let mut w = desk(&mut app, store, events, settings);
		let drawn = w.drawn("composer");
		assert_eq!(w.keys_in_composer(), drawn, "{name}: the keys follow the drawn composer");

		w.cx.simulate_input("Go");
		w.cx.run_until_parked();
		let typed = if drawn { "Go" } else { "" };
		assert_eq!(w.draft(), typed, "{name}: typing lands only in a drawn composer");
		if !drawn {
			w.cx.simulate_keystrokes("enter");
			w.cx.run_until_parked();
			let sent = w.sent();
			assert!(
				!sent
					.iter()
					.any(|action| matches!(action, HostAction::SubmitPrompt { .. })),
				"{name}: Enter sends no prompt from a window with no composer: {sent:?}"
			);
		}
	}
}

#[test]
fn no_composer_action_sends_a_request_the_host_withholds() {
	let mut leaked = Vec::new();
	for running in [false, true] {
		assert_eq!(
			needs(&sent_by_every_action(None, running)),
			BTreeSet::from(REACHED),
			"running {running}: the capabilities the composer's requests need"
		);
		for withheld in Capability::ALL {
			leaked.extend(
				sent_by_every_action(Some(withheld), running)
					.into_iter()
					.filter(|action| action_to_capability(action.kind()) == withheld)
					.map(|action| (running, withheld, action)),
			);
		}
	}
	assert_eq!(leaked, Vec::new(), "(running, withheld, sent)");
}
