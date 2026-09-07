//! WHY THIS SUITE EXISTS
//!
//! A tool card's disclosure is held by the host, not the window: expanding one
//! makes the host regenerate its `ToolView` with the hidden lines in it, and
//! the pointer path reports every click through `Intent::SetToolViewExpanded`.
//! The keyboard path expanded the same card locally and reported nothing, so
//! `space` opened the card's body over the collapsed view while a click on the
//! same card opened the full one. Two gestures, one card, two different cards.
//!
//! THE CLASS THIS CLOSES: a disclosure gesture whose local effect and whose
//! report to the host disagree. The suite sweeps every block kind the keyboard
//! can disclose, from the source list the shell matches on, and pins the set
//! that reports by exact equality — so a block kind whose disclosure the host
//! comes to own, or one that stops reporting, turns this red rather than
//! shipping a card that opens differently under two gestures.
//!
//! WHAT IT DOES NOT CATCH: what the host does with the report (regenerating the
//! view is asserted in the gui-host suites), the pointer path's own hit region
//! (`a-click-lands-on-the-row-tab-card-or-drawer-it-named.rs`), and the
//! rendering of an expanded view (`tool_view_surface_contract.rs`).

use std::{cell::RefCell, path::Path, rc::Rc, sync::Arc};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{
	StatusRowView, ToolPresentation, ToolView, ViewStatus, ViewTone,
};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Keymap, ShellState, ShellView, install_tokens,
	model::{Artifact, Block, ToolInvocationViews, Turn},
};
use veyyon_gpui::{App, AppContext, Entity, Window};

/// A host-supplied view of one call, which is what makes a card's disclosure
/// the host's to answer.
fn presentation(expanded: bool) -> Arc<ToolPresentation> {
	Arc::new(ToolPresentation {
		expanded,
		view: ToolView::StatusRow(StatusRowView {
			status: Some(ViewStatus::Success),
			title: "Ran 6 tests".into(),
			title_tone: Some(ViewTone::Title),
			description: Some("bash".into()),
			description_fits: true,
			..StatusRowView::default()
		}),
	})
}

/// Every block kind the shell's keyboard toggle will disclose, named by the
/// match in `sync_transcript_viewport`, each in a turn of its own.
fn disclosable_blocks() -> Vec<(&'static str, Block)> {
	vec![
		("Invoke", Block::Invoke {
			call_id: "call-1".to_owned(),
			tool:    "bash".to_owned(),
			target:  "sleep 9".to_owned(),
			result:  Some("running 6 tests".to_owned()),
			views:   ToolInvocationViews { call: None, result: Some(presentation(false)) },
		}),
		("Reason", Block::Reason("weighing two options".to_owned())),
		("Pane", Block::Pane { caption: "output".to_owned(), lines: vec!["ok".to_owned()] }),
		("Unknown", Block::Unknown {
			producer: "custom".to_owned(),
			lines:    vec!["payload".to_owned()],
		}),
		(
			"Artifact",
			Block::Artifact(Artifact::File {
				path:               "src/main.rs".to_owned(),
				has_content:        true,
				lines:              Some(1),
				bytes:              Some(14),
				unavailable_reason: None,
				image:              None,
			}),
		),
	]
}

fn options() -> RenderOptions {
	RenderOptions { width: 1180, height: 800, scale_factor: 1.0, ..RenderOptions::default() }
}

fn shell(
	state: ShellState,
	drained: Rc<RefCell<Vec<Intent>>>,
) -> impl FnOnce(&mut Window, &mut App) -> Entity<ShellView> {
	move |_window, app| {
		let tokens = load_bundled_tokens().expect("tokens load");
		let theme = load_bundled_theme("dark").expect("theme loads");
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		let view = app.new(|_| ShellView::new(installed, state));
		app.observe(&view, move |view, app| {
			let intents = view.update(app, |view, _| view.drain_intents());
			drained.borrow_mut().extend(intents);
		})
		.detach();
		view
	}
}

fn state_with(blocks: Vec<Block>) -> ShellState {
	ShellState {
		connection: ConnectionPhase::Attached,
		transcript: blocks
			.into_iter()
			.map(|block| Turn::Agent(vec![block]))
			.collect(),
		..ShellState::default()
	}
}

/// The disclosure reports a keyboard toggle produced, in dispatch order.
fn reported(drained: &Rc<RefCell<Vec<Intent>>>) -> Vec<(String, bool)> {
	drained
		.borrow()
		.iter()
		.filter_map(|intent| match intent {
			Intent::SetToolViewExpanded { call_id, expanded } => Some((call_id.clone(), *expanded)),
			_ => None,
		})
		.collect()
}

#[test]
fn a_keyboard_toggle_reports_the_new_disclosure_state_of_a_host_viewed_card() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let blocks = disclosable_blocks();
	let invoke = blocks
		.iter()
		.find(|(name, _)| *name == "Invoke")
		.map(|(_, block)| block.clone())
		.expect("an invoke block");
	let mut session = HeadlessSession::open(
		&mut cx,
		&options(),
		shell(state_with(vec![invoke]), Rc::clone(&drained)),
	)
	.expect("session opens");
	session.frame().expect("first frame");
	drained.borrow_mut().clear();

	session
		.update(|view, _window, cx| view.dispatch(Intent::ToggleBlock, cx))
		.expect("keyboard toggle dispatches");
	session.frame().expect("frame after expanding");
	assert_eq!(
		reported(&drained),
		vec![("call-1".to_owned(), true)],
		"expanding a card from the keyboard must tell the host the card is open"
	);

	drained.borrow_mut().clear();
	session
		.update(|view, _window, cx| view.dispatch(Intent::ToggleBlock, cx))
		.expect("keyboard toggle dispatches");
	session.frame().expect("frame after collapsing");
	assert_eq!(
		reported(&drained),
		vec![("call-1".to_owned(), false)],
		"collapsing it again must report the closed state, not repeat the open one"
	);
}

#[test]
fn only_the_block_kinds_whose_disclosure_the_host_owns_report_to_it() {
	let blocks = disclosable_blocks();
	let mut reporting = Vec::new();
	for (name, block) in blocks {
		let mut cx = headless_context().expect("headless context available");
		let drained = Rc::new(RefCell::new(Vec::new()));
		let mut session = HeadlessSession::open(
			&mut cx,
			&options(),
			shell(state_with(vec![block]), Rc::clone(&drained)),
		)
		.expect("session opens");
		session.frame().expect("first frame");
		drained.borrow_mut().clear();
		session
			.update(|view, _window, cx| view.dispatch(Intent::ToggleBlock, cx))
			.expect("keyboard toggle dispatches");
		session.frame().expect("frame after toggle");
		if !reported(&drained).is_empty() {
			reporting.push(name);
		}
	}
	assert_eq!(
		reporting,
		vec!["Invoke"],
		"the host holds a tool card's disclosure and nothing else's; a new host-held block kind \
		 must be reported here rather than opening two ways"
	);
}

#[test]
fn a_card_with_no_host_view_expands_locally_and_reports_nothing() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	// A call the host supplied no view for: the window draws the recorded target
	// and output itself, so there is nothing for a host to regenerate and a
	// report would name a call no ledger holds.
	let bare = Block::Invoke {
		call_id: "call-2".to_owned(),
		tool:    "bash".to_owned(),
		target:  "git --version".to_owned(),
		result:  Some("git version 2.51.0".to_owned()),
		views:   ToolInvocationViews::default(),
	};
	let mut session = HeadlessSession::open(
		&mut cx,
		&options(),
		shell(state_with(vec![bare]), Rc::clone(&drained)),
	)
	.expect("session opens");
	session.frame().expect("first frame");
	drained.borrow_mut().clear();

	session
		.update(|view, _window, cx| view.dispatch(Intent::ToggleBlock, cx))
		.expect("keyboard toggle dispatches");
	session.frame().expect("frame after toggle");
	assert!(
		reported(&drained).is_empty(),
		"a card the host supplied no view for has no host-held disclosure to report"
	);
}
