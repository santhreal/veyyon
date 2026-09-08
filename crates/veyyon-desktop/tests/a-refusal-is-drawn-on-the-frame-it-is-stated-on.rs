//! WHY THIS SUITE EXISTS:
//! A field that refuses what was typed states the refusal in the attention
//! strip and sends nothing. Sending nothing reached no `dispatch`, and nothing
//! else marked the window dirty, so the strip was held in the state and drawn
//! on whatever later frame some unrelated interaction happened to request.
//! `desktop-settings-keybinding` caught it as an invalid chord that changed
//! zero pixels in the strip band. Two defects stood behind that one. The
//! refusal and the host's connection commentary wrote one field, so the strip
//! drew a refusal for two frames and the next heartbeat — which reports a
//! healthy socket and therefore no notice — erased it 67 milliseconds later.
//! And the chord was read for validity by `KeyChord::parse`, which reads a
//! chord for a chip to draw, so `ctrl-` was taken as a hyphen with a modifier
//! and written to the keymap as a modifier with no key.
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
//! turns this red rather than shrinking the sweep. Each case reaches the
//! refusal through the editor the drawn surface registered and a return on it,
//! never by calling the refusal itself, and each asserts an idle frame draws
//! nothing first, so a window that repaints every vsync cannot pass by
//! accident.
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

use serde_json::json;
use strum::{EnumIter, IntoEnumIterator};
use support::fields::{
	SETTING_KEY, driven, general_page_holds, keybindings_page_binds, settings_page_open,
	transport_asks_for_a_secret,
};
use veyyon_desktop_model::SettingKind;
use veyyon_desktop_scene::{HeadlessSession, RgbaFrame};
use veyyon_desktop_surface::{
	ConnectionPhase, FieldKey, SettingsPage, ShellState, ShellView, fixture,
};

/// The keymap action a seeded Keybindings page reports a binding for.
const BOUND_ACTION: &str = "shell::Submit";

/// A field, without the value that names which one, so the sweep can be
/// checked against the set of fields that exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, EnumIter)]
enum KeyShape {
	/// [`FieldKey::AuthSecret`].
	AuthSecret,
	/// [`FieldKey::Setting`].
	Setting,
	/// [`FieldKey::SessionRename`].
	SessionRename,
	/// [`FieldKey::Keybinding`].
	Keybinding,
	/// [`FieldKey::TaskPrompt`].
	TaskPrompt,
}

/// The exhaustive match that makes a new `FieldKey` fail to compile here until
/// its refusal is recorded.
const fn key_shape(key: &FieldKey) -> KeyShape {
	match key {
		FieldKey::AuthSecret => KeyShape::AuthSecret,
		FieldKey::Setting(_) => KeyShape::Setting,
		FieldKey::SessionRename(_) => KeyShape::SessionRename,
		FieldKey::Keybinding(_) => KeyShape::Keybinding,
		FieldKey::TaskPrompt => KeyShape::TaskPrompt,
	}
}

/// One field, the shell it is drawn in, and the text a return on it refuses.
struct Case {
	/// The field the seeded surface draws.
	key:   FieldKey,
	/// The shell the field is drawn in.
	state: ShellState,
	/// What the field is left holding before the return. Empty text is what a
	/// field cleared by the operator holds, which every field but the keymap
	/// one refuses; a keymap field refuses anything that states no chord.
	text:  &'static str,
	/// What the attention strip has to say, in full or as its opening, since
	/// a JSON refusal quotes the parser.
	says:  &'static str,
	/// What the same field takes, so the refusal it put up is withdrawn on
	/// the frame that takes it rather than left standing over a value that
	/// was accepted.
	takes: &'static str,
}

/// Every field that refuses, each seeded in a shell that draws it.
fn cases() -> Vec<Case> {
	vec![
		Case {
			key:   FieldKey::AuthSecret,
			state: transport_asks_for_a_secret(),
			text:  "",
			says:  "A secret is required to authenticate",
			takes: "sk-typed-by-the-operator",
		},
		Case {
			key:   FieldKey::Setting(SETTING_KEY.to_owned()),
			state: general_page_holds(SettingKind::Record, json!({})),
			text:  "not json at all",
			says:  "settings.seeded is not valid JSON",
			takes: "{\"seeded\":true}",
		},
		Case {
			key:   FieldKey::SessionRename(fixture::populated().current_id),
			state: ShellState { connection: ConnectionPhase::Attached, ..fixture::populated() },
			text:  "",
			says:  "A session name cannot be empty",
			takes: "A name the operator typed",
		},
		Case {
			key:   FieldKey::Keybinding(BOUND_ACTION.to_owned()),
			state: keybindings_page_binds(BOUND_ACTION, &["ctrl-enter"]),
			// Modifiers with no key after them: the keymap grammar reads no
			// chord out of it, so no key press would ever match what it would
			// have been bound to.
			text:  "ctrl-",
			says:  "shell::Submit needs at least one chord",
			takes: "ctrl-enter",
		},
		Case {
			key:   FieldKey::Keybinding(BOUND_ACTION.to_owned()),
			state: keybindings_page_binds(BOUND_ACTION, &["ctrl-enter"]),
			// Modifiers spelled apart: one token of the grammar carries no
			// space inside it, so this states no chord either.
			text:  "ctrl alt",
			says:  "shell::Submit needs at least one chord",
			takes: "ctrl-enter, cmd-enter",
		},
		Case {
			key:   FieldKey::TaskPrompt,
			// The Agents page is the one that draws the task field, and a
			// field the surface never drew takes no return.
			state: settings_page_open(SettingsPage::Extensions),
			text:  "",
			says:  "A task needs a description to run",
			takes: "Read the tokens and report what is unauthored",
		},
	]
}

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

/// Focuses the editor the drawn surface registered under `key` and leaves it
/// holding `text`, so the return that follows submits exactly that.
fn hold(session: &mut HeadlessSession<'_, ShellView>, key: &FieldKey, text: &str) {
	let key = key.clone();
	let text = text.to_owned();
	session
		.update(move |view, window, cx| {
			let editor = view
				.retained_field(&key)
				.expect("the drawn surface registered an editor under the field it holds");
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
			editor.update(cx, |editor, cx| editor.set_text(text, cx));
		})
		.expect("the field takes focus and the text it is asked to hold");
}

#[test]
fn every_field_that_refuses_is_swept_here() {
	let swept: BTreeSet<KeyShape> = cases().iter().map(|case| key_shape(&case.key)).collect();
	let declared: BTreeSet<KeyShape> = KeyShape::iter().collect();
	assert_eq!(
		swept, declared,
		"every field the registry declares is swept for a refusal that is drawn"
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
