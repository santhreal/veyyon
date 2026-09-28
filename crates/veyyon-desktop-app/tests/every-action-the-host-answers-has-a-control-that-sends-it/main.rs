//! Every action the host answers is sent by a control the operator reaches.
//!
//! WHY: an action no control sends is protocol the window can never use. The
//! host implements it and the wire carries it, and no press reaches it; the
//! window this app replaced shipped with twenty-one such actions. The census
//! sweeps `HostActionKind::iter()` against the senders each region lists,
//! each kind exactly once, and pins the kinds no control sends by exact
//! equality, so a kind added to the protocol is red here until a control
//! sends it or it is pinned with its reason. The drive opens a whole window
//! over a host that grants every capability, performs each sender's gesture
//! the way the operator does (a chord, a palette row, a click on a drawn
//! control, typed text) and requires the requests the gesture queued to
//! include one of that kind.
//!
//! Gap: one gesture per kind. It does not prove the request's payload, the
//! gate that withholds the control, or every control that sends the kind;
//! each region's suite owns those. It does not prove the control is drawn at
//! every window width.

mod composer;
mod harness;
mod panel;
mod settings;
mod thread;

use std::collections::BTreeMap;

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{HostAction, HostActionKind};

use self::harness::{Win, install, window};

/// Kinds no control sends, each with the reason. Empty: every kind the host
/// answers has a control.
const PINNED_UNSENT: &[(HostActionKind, &str)] = &[];

/// One control that sends one kind of request.
pub struct Sender {
	/// The kind of request the gesture queues.
	pub kind:    HostActionKind,
	/// The control as the operator finds it, for the failure message.
	pub control: &'static str,
	/// The gesture, performed on a window at rest over [`harness::world`].
	/// It reaches the control through chords, palette rows, clicks and
	/// typed text, never by calling the app state.
	pub drive:   fn(&mut Win<'_>),
}

/// Every region's senders.
fn senders() -> impl Iterator<Item = &'static Sender> {
	[composer::SENDERS, thread::SENDERS, panel::SENDERS, settings::SENDERS]
		.into_iter()
		.flatten()
}

#[test]
fn every_kind_has_one_sender_or_is_pinned_unsent() {
	let mut listed: BTreeMap<HostActionKind, Vec<&str>> = BTreeMap::new();
	for sender in senders() {
		listed.entry(sender.kind).or_default().push(sender.control);
	}
	let twice: Vec<_> = listed
		.iter()
		.filter(|(_, controls)| controls.len() > 1)
		.collect();
	assert!(twice.is_empty(), "a kind is listed by one sender, not {twice:?}");
	let unsent: Vec<HostActionKind> = HostActionKind::iter()
		.filter(|kind| !listed.contains_key(kind))
		.collect();
	let pinned: Vec<HostActionKind> = PINNED_UNSENT.iter().map(|(kind, _)| *kind).collect();
	assert_eq!(
		unsent, pinned,
		"every kind no control sends is pinned, and no pinned kind has a sender"
	);
}

/// Opens a fresh window for each of `senders`, performs its gesture and
/// requires a request of its kind among the ones the gesture queued.
fn drive(app: &mut TestAppContext, senders: &[Sender]) {
	install(app);
	for sender in senders {
		let mut w = window(app);
		(sender.drive)(&mut w);
		let sent: Vec<HostActionKind> = w.outbox().iter().map(HostAction::kind).collect();
		assert!(
			sent.contains(&sender.kind),
			"{} sends {:?}; the gesture queued {sent:?}",
			sender.control,
			sender.kind,
		);
	}
}

#[gpui::test]
fn the_composer_and_the_dock_send_each_kind_they_list(app: &mut TestAppContext) {
	drive(app, composer::SENDERS);
}

#[gpui::test]
fn the_thread_the_sidebar_and_the_palette_send_each_kind_they_list(app: &mut TestAppContext) {
	drive(app, thread::SENDERS);
}

#[gpui::test]
fn the_panel_and_the_drawer_send_each_kind_they_list(app: &mut TestAppContext) {
	drive(app, panel::SENDERS);
}

#[gpui::test]
fn the_settings_sheet_sends_each_kind_it_lists(app: &mut TestAppContext) {
	drive(app, settings::SENDERS);
}
