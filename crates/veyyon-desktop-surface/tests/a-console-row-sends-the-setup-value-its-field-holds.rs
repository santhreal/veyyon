//! WHY: the console's rows were drawn before anything read them back. A text
//! row committed through `commit_field`, and the stepper, the toggle and the
//! segmented row each built their own change inline in the element that drew
//! them, so the bound a stepper was drawn against and the bound its change
//! respected were two definitions. A `-` offered at the minimum would have
//! sent a value under it, and the host would have answered a refusal the
//! window asked for.
//!
//! THE CLASS THIS CLOSES:
//! A row kind that draws a control sending the wrong value, or sending one at
//! all where the row admits no change. `AutoswarmFieldKind::iter()` is swept,
//! so a fifth kind turns this red until what it sends is recorded, and each
//! kind is asserted against the exact `Intent::SetAutoswarmField` it raises:
//! the field it names, the value it carries, and that the other two payload
//! fields stay empty, since a change carrying both a number and a text is one
//! the host reads twice. Both bounds of a stepper are asserted, from inside
//! and from on the bound, and the option a segmented row already holds is
//! asserted to send nothing. The text row is driven through the editor the
//! drawn card registered and a return on it, so a commit wired to another key,
//! or a card that stops drawing the field, fails here rather than passing
//! against a direct call. The save row is driven the same way: a return there
//! saves the setup under the typed name instead of setting a value, and an
//! unnamed one sends nothing and states what to type, so a save row wired to
//! the ordinary text commit fails here.
//!
//! WHAT IT DOES NOT CATCH:
//! What the host does with the change is
//! `an-intent-maps-to-the-actions-the-host-answers`'s subject, and whether the
//! gate offers the control at all is the availability suite's. It reads the
//! change a control carries, not the pixels it is drawn as: a control drawn
//! inert still carries no change here, and that it looks inert is the token
//! contrast suite's subject. The console's own formatting is the host's, so a
//! row stating `3 arms` over a number of 4 is a defect on the host's side and
//! invisible here.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{
	AutoswarmConsoleView, AutoswarmFieldKind, AutoswarmFieldView, AutoswarmOptionView,
};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	AutoswarmState, FieldKey, Intent, Keymap, Overlay, ShellState, ShellView,
	autoswarm::change::{option_change, step_change, toggle_change},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The text a row is left holding before the return that sends it.
const TYPED: &str = "lower p50 latency";

/// The row a preset is named in, which the console states as its save row.
const SAVE_ROW: &str = "save";

/// The name a preset is saved under, typed into the save row.
const PRESET: &str = "tuned";

/// One row of each kind, each with the bounds and options its kind carries.
fn row(kind: AutoswarmFieldKind) -> AutoswarmFieldView {
	let (id, display) = match kind {
		AutoswarmFieldKind::Text => ("goal", "unset"),
		AutoswarmFieldKind::Stepper => ("arms", "3 arms"),
		AutoswarmFieldKind::Toggle => ("worktrees", "Off"),
		AutoswarmFieldKind::Segmented => ("preset", "Balanced"),
	};
	AutoswarmFieldView {
		id: id.to_owned(),
		kind,
		label: "Goal".to_owned(),
		hint: "What the swarm optimizes".to_owned(),
		display: display.to_owned(),
		text: match kind {
			AutoswarmFieldKind::Text => Some(String::new()),
			AutoswarmFieldKind::Segmented => Some("balanced".to_owned()),
			AutoswarmFieldKind::Stepper | AutoswarmFieldKind::Toggle => None,
		},
		placeholder: Some("what to optimize".to_owned()),
		number: (kind == AutoswarmFieldKind::Stepper).then_some(3),
		min: (kind == AutoswarmFieldKind::Stepper).then_some(1),
		max: (kind == AutoswarmFieldKind::Stepper).then_some(8),
		on: (kind == AutoswarmFieldKind::Toggle).then_some(false),
		options: if kind == AutoswarmFieldKind::Segmented {
			vec![
				AutoswarmOptionView {
					value:     "balanced".to_owned(),
					label:     "Balanced".to_owned(),
					selected:  true,
					removable: false,
				},
				AutoswarmOptionView {
					value:     "wide".to_owned(),
					label:     "Wide".to_owned(),
					selected:  false,
					removable: false,
				},
			]
		} else {
			Vec::new()
		},
	}
}

/// The row a preset is named in, which every console with presets carries.
fn save_row() -> AutoswarmFieldView {
	AutoswarmFieldView {
		id:          SAVE_ROW.to_owned(),
		kind:        AutoswarmFieldKind::Text,
		label:       "Save as".to_owned(),
		hint:        "The name this setup is saved under".to_owned(),
		display:     String::new(),
		text:        Some(String::new()),
		placeholder: Some("preset name".to_owned()),
		number:      None,
		min:         None,
		max:         None,
		on:          None,
		options:     Vec::new(),
	}
}

/// A console holding one row of every kind, plus the row a preset is named
/// in, which is the card this drives.
fn console() -> AutoswarmConsoleView {
	let mut fields: Vec<AutoswarmFieldView> = AutoswarmFieldKind::iter().map(row).collect();
	fields.push(save_row());
	AutoswarmConsoleView {
		session: fixture::populated().current_id.to_string(),
		swarm: None,
		fields,
		notes: Vec::new(),
		actions: Vec::new(),
		runs: Vec::new(),
		save_field: Some(SAVE_ROW.to_owned()),
	}
}

/// A window with the console open on the session the fixture holds.
fn console_state() -> ShellState {
	let mut state = AutoswarmState::new();
	state.console = Some(console());
	ShellState { overlay: Some(Overlay::Autoswarm(Box::new(state))), ..fixture::populated() }
}

/// Opens a window on the console card and runs `drive` against it.
fn driven<R>(drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, console_state()))
	})
	.expect("session opens");
	drive(&mut session)
}

/// The change one value of `field` sends, for the kinds whose control is a
/// press rather than a typed line.
fn pressed(kind: AutoswarmFieldKind) -> Option<Intent> {
	let field = row(kind);
	match kind {
		AutoswarmFieldKind::Toggle => Some(toggle_change(&field)),
		AutoswarmFieldKind::Stepper => step_change(&field, 1),
		AutoswarmFieldKind::Segmented => option_change(&field, 1),
		// A text row sends on a return, which `a_text_row_sends_the_line_it_
		// holds` drives through the editor the card registered.
		AutoswarmFieldKind::Text => None,
	}
}

#[test]
fn every_row_kind_states_what_its_control_sends() {
	for kind in AutoswarmFieldKind::iter() {
		let id = row(kind).id;
		let expected = match kind {
			AutoswarmFieldKind::Text => None,
			AutoswarmFieldKind::Stepper => Some(Intent::SetAutoswarmField {
				field:  id.clone(),
				text:   None,
				number: Some(4),
				on:     None,
			}),
			AutoswarmFieldKind::Toggle => Some(Intent::SetAutoswarmField {
				field:  id.clone(),
				text:   None,
				number: None,
				on:     Some(true),
			}),
			AutoswarmFieldKind::Segmented => Some(Intent::SetAutoswarmField {
				field:  id.clone(),
				text:   Some("wide".to_owned()),
				number: None,
				on:     None,
			}),
		};
		assert_eq!(
			pressed(kind),
			expected,
			"{kind:?} sends the value its control names, and nothing in the other payload fields"
		);
	}
}

#[test]
fn a_stepper_sends_no_value_past_the_bound_it_is_on() {
	let mut field = row(AutoswarmFieldKind::Stepper);
	field.number = Some(1);
	assert_eq!(step_change(&field, -1), None, "a step under the minimum sends nothing");
	assert!(step_change(&field, 1).is_some(), "the row still steps up from its minimum");

	field.number = Some(8);
	assert_eq!(step_change(&field, 1), None, "a step over the maximum sends nothing");
	assert!(step_change(&field, -1).is_some(), "the row still steps down from its maximum");
}

#[test]
fn a_row_the_console_stated_no_number_for_steps_from_zero() {
	// A console that has not filled a row yet states no number for it, and a
	// step of it is the first value the host is told, not a step of nothing.
	let field =
		AutoswarmFieldView { number: None, min: None, max: None, ..row(AutoswarmFieldKind::Stepper) };
	assert_eq!(
		step_change(&field, 1),
		Some(Intent::SetAutoswarmField {
			field:  field.id.clone(),
			text:   None,
			number: Some(1),
			on:     None,
		}),
		"an unfilled row steps from zero"
	);
}

#[test]
fn choosing_the_option_a_row_already_holds_sends_nothing() {
	let field = row(AutoswarmFieldKind::Segmented);
	assert_eq!(option_change(&field, 0), None, "the option the row is on sends no change");
	assert_eq!(option_change(&field, 9), None, "an option the row does not offer sends no change");
}

/// Focuses the console row `field`, leaves it holding `text`, drops what the
/// opening frame raised, and returns what a return on the row sent and what
/// the window states after it.
fn returned(field: &str, text: &str) -> (Vec<Intent>, Option<String>) {
	let key = FieldKey::AutoswarmField(field.to_owned());
	let text = text.to_owned();
	driven(|session| {
		session.frame().expect("the console card renders");
		session
			.update(move |view, window, cx| {
				let editor = view
					.retained_field(&key)
					.expect("the drawn card registered an editor for its text row");
				let focus = editor.read(cx).focus_handle().clone();
				window.focus(&focus, cx);
				editor.update(cx, |editor, cx| editor.set_text(text, cx));
			})
			.expect("the row takes focus and the line it is asked to hold");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		session.keystroke("enter").expect("the row takes a return");
		session
			.update(|view, _window, _cx| (view.drain_intents(), view.notice().map(str::to_owned)))
			.expect("what the return raised is read back")
	})
}

#[test]
fn a_text_row_sends_the_line_it_holds() {
	let (sent, _) = returned("goal", TYPED);
	assert_eq!(
		sent,
		vec![Intent::SetAutoswarmField {
			field:  "goal".to_owned(),
			text:   Some(TYPED.to_owned()),
			number: None,
			on:     None,
		}],
		"the return sends one change, carrying the line the row holds"
	);
}

#[test]
fn the_save_row_saves_the_setup_under_the_name_it_holds() {
	let (sent, notice) = returned(SAVE_ROW, PRESET);
	assert_eq!(
		sent,
		vec![Intent::SaveAutoswarmPreset(PRESET.to_owned())],
		"a return on the save row saves the setup rather than setting a value on it"
	);
	assert_eq!(notice, None, "a named preset is sent with nothing stated over it");
}

#[test]
fn a_save_row_holding_no_name_sends_nothing_and_states_why() {
	// The host answers an unnamed preset with `INVALID_ARGUMENTS`, so sending
	// one would spend a round trip to learn what the row already states.
	let (sent, notice) = returned(SAVE_ROW, "   ");
	assert_eq!(sent, Vec::new(), "an unnamed preset is refused where it was typed");
	assert_eq!(
		notice.as_deref(),
		Some("A preset needs a name to save the setup under"),
		"the window states the condition and what to type"
	);
}
