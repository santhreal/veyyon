//! WHY: Field rejection did not request a frame; host heartbeats erased local
//! refusals; display-only chord parsing accepted a modifier without a key.
//! The native keybinding scene reproduced an unchanged attention strip.
//!
//! THE CLASS THIS CLOSES:
//! A line the attention strip is asked to carry and does not draw, from either
//! writer, and a value no press or parser can read being taken, for every
//! `FieldKey` the registry declares. The strip has one reader,
//! `ShellView::notice`, over two fields: the window's refusal outranks the
//! host's report of itself, and each writer repaints. `key_shape` matches
//! `FieldKey` exhaustively, so a new field fails to compile until its answer
//! is recorded, and `every_field_that_refuses_is_swept_here` pins the covered
//! shapes by exact equality against `KeyShape::iter()`, so deleting a case
//! turns this red rather than shrinking the sweep. A field that refuses
//! nothing is named in `REFUSES_NOTHING`, which the same equality counts, so
//! opting one out is a recorded decision rather than a missing case. Each case
//! reaches the refusal through the editor the drawn surface registered and a
//! return on it, never by calling the refusal itself, and each asserts an idle
//! frame draws nothing first, so a window that repaints every vsync cannot
//! pass by accident.
//!
//! WHAT IT DOES NOT CATCH:
//! It asserts the frame after the return differs from the one before it and
//! that the strip states the refusal; it does not read the prose out of the
//! pixels, so a strip drawn in an unreadable colour is the token contrast
//! suite's subject. A chord is checked against the grammar that binds it, not
//! against a key this machine has, so `ctrl-nosuchkey` is taken here and
//! matches no press. It says nothing about how long a refusal stays up, which
//! no surface decides, and it reaches the host's writer through `set_notice`
//! rather than through a socket, so a host loop that stops calling it at all
//! is the scene's subject.

mod support;

use std::collections::BTreeSet;

use strum::IntoEnumIterator;
use support::{
	fields::{driven, settings_page_open},
	refusals::{KeyShape, cases, hold, key_shape},
};
use veyyon_desktop_scene::RgbaFrame;
use veyyon_desktop_surface::SettingsPage;

/// The pixels two frames disagree on.
fn differing_pixels(before: &RgbaFrame, after: &RgbaFrame) -> usize {
	before
		.as_bytes()
		.chunks_exact(4)
		.zip(after.as_bytes().chunks_exact(4))
		.filter(|(a, b)| a != b)
		.count()
}

/// A band of prose across a window this wide draws more pixels than this, and
/// a window that redrew nothing draws none. Well under a strip's own area, so
/// the assertion is about a strip appearing rather than about its exact glyphs.
const PROSE: usize = 2_000;

/// The fields that refuse nothing, so a case here would have nothing to
/// assert. A query narrows the page it is typed on and is sent nowhere, so no
/// value of it is rejected; what it does instead is
/// `typing-in-the-settings-query-narrows-the-rows-the-page-draws`'s subject.
const REFUSES_NOTHING: [KeyShape; 1] = [KeyShape::SettingsQuery];

#[test]
fn every_field_that_refuses_is_swept_here() {
	let swept: BTreeSet<KeyShape> = cases().iter().map(|case| key_shape(&case.key)).collect();
	let opted_out: BTreeSet<KeyShape> = REFUSES_NOTHING.into_iter().collect();
	assert!(
		swept.is_disjoint(&opted_out),
		"a field recorded as refusing nothing is swept for a refusal as well"
	);
	let declared: BTreeSet<KeyShape> = KeyShape::iter().collect();
	assert_eq!(
		&swept | &opted_out,
		declared,
		"every field the registry declares is swept for a refusal that is drawn, or recorded here \
		 as refusing nothing"
	);
}

#[test]
fn a_refusal_repaints_the_window_that_states_it() {
	for case in cases() {
		let key = case.key.clone();
		let says = case.says;
		let (idle, drawn, notice) = driven(case.state, |session| {
			hold(session, &key, case.text);
			let before = session.frame().expect("the field draws what it holds");
			// A window with nothing pending draws nothing, so this is the
			// frame already on screen. Without it a window repainting every
			// vsync would pass the assertion below for the wrong reason.
			let idle = session.frame().expect("an idle window is captured again");
			let idle = differing_pixels(&before.frame, &idle.frame);
			session
				.keystroke("enter")
				.expect("the field takes a return");
			let after = session
				.frame()
				.expect("the frame after the return is captured");
			let drawn = differing_pixels(&before.frame, &after.frame);
			let notice = session
				.update(|view, _window, _cx| view.notice().map(str::to_owned))
				.expect("the window is read after the return");
			(idle, drawn, notice)
		});
		assert_eq!(
			idle, 0,
			"{says}: an idle window redraws nothing, so a differential means a repaint"
		);
		let notice = notice.unwrap_or_else(|| panic!("{says}: the refusal is stated in the window"));
		assert!(notice.starts_with(says), "the strip states the refusal it holds: {notice}");
		assert!(
			drawn > PROSE,
			"{says}: the refusal is drawn on the frame it is stated on, and this one changed {drawn} \
			 pixels, under the {PROSE} a band of prose draws"
		);
	}
}

#[test]
fn a_refusal_is_withdrawn_on_the_frame_that_takes_the_value() {
	for case in cases() {
		let key = case.key.clone();
		let says = case.says;
		let (refused, drawn, notice) = driven(case.state, |session| {
			hold(session, &key, case.text);
			session
				.keystroke("enter")
				.expect("the field takes a return");
			let refused = session
				.update(|view, _window, _cx| view.notice().map(str::to_owned))
				.expect("the window is read after the refusal");
			let before = session.frame().expect("the strip is drawn");
			hold(session, &key, case.takes);
			let _ = session
				.frame()
				.expect("the field draws the value it now holds");
			session
				.keystroke("enter")
				.expect("the field takes a second return");
			let after = session.frame().expect("the frame after the second return");
			let drawn = differing_pixels(&before.frame, &after.frame);
			let notice = session
				.update(|view, _window, _cx| view.notice().map(str::to_owned))
				.expect("the window is read after the value is taken");
			(refused, drawn, notice)
		});
		assert!(
			refused.is_some_and(|notice| notice.starts_with(says)),
			"{says}: the refusal is up before the value that withdraws it is typed"
		);
		assert_eq!(
			notice, None,
			"{says}: the refusal is withdrawn once the field states a value that is taken"
		);
		assert!(
			drawn > PROSE,
			"{says}: the strip coming down is drawn on the frame it comes down on, and this one \
			 changed {drawn} pixels, under the {PROSE} a band of prose draws"
		);
	}
}

#[test]
fn a_host_reporting_its_own_state_does_not_erase_a_refusal() {
	for case in cases() {
		let key = case.key.clone();
		let says = case.says;
		let (over_healthy, over_commentary, drawn) = driven(case.state, |session| {
			hold(session, &key, case.text);
			session
				.keystroke("enter")
				.expect("the field takes a return");
			let before = session.frame().expect("the strip is drawn");
			// What the host loop does on a batch that carries no notice of
			// its own, which is every heartbeat reporting a healthy socket.
			let over_healthy = session
				.update(|view, _window, cx| {
					view.set_notice(None, cx);
					view.notice().map(str::to_owned)
				})
				.expect("the host reports a healthy socket");
			// And with commentary of its own, which is still about the
			// transport rather than about what was just typed.
			let over_commentary = session
				.update(|view, _window, cx| {
					view.set_notice(Some("syncing 3/9".to_owned()), cx);
					view.notice().map(str::to_owned)
				})
				.expect("the host reports a sync in progress");
			let after = session.frame().expect("the frame after the host reported");
			(over_healthy, over_commentary, differing_pixels(&before.frame, &after.frame))
		});
		assert!(
			over_healthy.is_some_and(|notice| notice.starts_with(says)),
			"{says}: a heartbeat carrying no notice leaves the refusal standing"
		);
		assert!(
			over_commentary.is_some_and(|notice| notice.starts_with(says)),
			"{says}: the refusal outranks what the host reports about its own connection"
		);
		assert!(
			drawn < PROSE,
			"{says}: the strip states the same line after the host reported, so the band is not \
			 redrawn with other prose, and this frame changed {drawn} pixels"
		);
	}
}

#[test]
fn a_notice_the_host_reports_is_drawn_on_the_frame_it_arrives_on() {
	// No refusal stands here, so the strip carries the host's channel alone:
	// the same band, reached by the other writer, which sends nothing either.
	let (idle, drawn, states) = driven(settings_page_open(SettingsPage::Extensions), |session| {
		let before = session
			.frame()
			.expect("the shell draws a frame with no strip");
		let idle = session.frame().expect("an idle window is captured again");
		let idle = differing_pixels(&before.frame, &idle.frame);
		let states = session
			.update(|view, _window, cx| {
				view.set_notice(Some("syncing 3/9".to_owned()), cx);
				view.notice().map(str::to_owned)
			})
			.expect("the host reports a sync in progress");
		let after = session.frame().expect("the frame after the host reported");
		(idle, differing_pixels(&before.frame, &after.frame), states)
	});
	assert_eq!(idle, 0, "an idle window redraws nothing, so a differential means a repaint");
	assert_eq!(states.as_deref(), Some("syncing 3/9"), "the strip states what the host reported");
	assert!(
		drawn > PROSE,
		"a notice the host reports is drawn on the frame it arrives on, and this one changed \
		 {drawn} pixels, under the {PROSE} a band of prose draws"
	);
}
