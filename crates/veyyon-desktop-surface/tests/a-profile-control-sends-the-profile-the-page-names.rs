//! WHY: the Profiles page draws one name field and three verbs over a list of
//! profile directories, and every one of them acts on a name that is not in
//! the control that was pressed: `Create` takes the field plus the switches
//! under it, `Rename` takes the row it sits on plus that same field, and
//! `Delete` takes only its row. A control wired to the wrong one of those, or
//! to a name of nothing, either writes a profile directory nobody asked for or
//! removes one somebody is using, and neither is recoverable from the window.
//!
//! CLASS CLOSED: a control the page draws sends the profile it names, or it
//! sends nothing and states why. Every press is made on the word the frame
//! drew, so a control wired to nothing fails here rather than passing on a
//! direct call to the method behind it. The sweep is over the listing the page
//! is given -- derived from the fixture at run time, not written out -- and
//! over what the field holds, and it requires that:
//!
//! 1. Each row the listing calls inactive draws a `Delete` that removes that
//!    row's own directory, and the active row draws none at all, since the host
//!    serves that profile and cannot remove it underneath itself.
//! 2. `Create` sends the field's name with exactly the copy keys the switches
//!    leave on, all of them by default and none of them with every switch off.
//! 3. `Rename` sends the row it is on with the field's text as the new display
//!    name, leaving the directory name alone.
//! 4. A name of nothing -- empty or whitespace -- raises no intent at all from
//!    either verb that reads the field, and states a refusal on the surface.
//!
//! GAPS: what the host does with a create, a rename or a delete is the store's
//! contract, proved in
//! `packages/coding-agent/test/gui-host/
//! a-window-lists-the-profiles-on-disk-and-changes-the-set.test.ts`.
//! Which profile a window is attached to is not changed from here at all: a
//! host serves the profile it was started under.

mod support;

use std::path::Path;

use support::settings_seed::seed_state_for_page;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::ProfileView;
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Captured, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Keymap, Overlay, SettingsPage, SettingsState, ShellState, ShellView,
	install_tokens, navigation::SurfaceRoute,
};
use veyyon_desktop_tokens::MotionModel;
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1180;
const HEIGHT: u32 = 900;

/// The seeded page, which is the listing every case below is derived from.
fn seeded() -> SettingsState {
	let mut settings = seed_state_for_page(SettingsPage::Profiles);
	settings.route = Some(SurfaceRoute::Page(SettingsPage::Profiles));
	settings
}

/// The rows the page is given, in the order it draws them.
fn listed() -> Vec<ProfileView> {
	seeded()
		.profiles
		.expect("the seeded page lists profiles")
		.entries
}

/// Opens a window on the Profiles page holding `settings` and runs `drive`.
fn driven<R>(
	settings: SettingsState,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let mut tokens = load_bundled_tokens().expect("tokens load");
	let MotionModel::SpringFade(float) = &mut tokens.motion.float.model else {
		panic!("the float role must use its spring-fade model");
	};
	float.rise_px = 0.0;
	float.fade_duration_ms = 0;
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		let state = ShellState {
			connection: ConnectionPhase::Attached,
			overlay: Some(Overlay::Settings(Box::new(settings))),
			..ShellState::default()
		};
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the profiles page opens");
	drive(&mut session)
}

/// Every place the frame drew exactly `label`, as the centre of each run.
fn drawn(captured: &Captured, label: &str) -> Vec<Point<f32>> {
	captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect()
}

/// What a press left behind: what it raised and what the surface states.
struct Pressed {
	intents: Vec<Intent>,
	notice:  Option<String>,
}

/// Types `name` into the page's one name field, presses the `nth` occurrence
/// of `label`, and reads back what that did. `name` of `None` leaves the field
/// as the page opened it, which is empty.
fn press(settings: SettingsState, name: Option<&str>, label: &str, nth: usize) -> Pressed {
	let typed = name.map(str::to_owned);
	driven(settings, |session| {
		let captured = session.frame().expect("the profiles page renders");
		if let Some(typed) = typed {
			session
				.update(move |view, _window, cx| {
					let editor = view.profile_name_field_editor(cx);
					editor.update(cx, |editor, cx| editor.set_text(typed, cx));
				})
				.expect("the page draws a name field");
		}
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		let at = drawn(&captured, label);
		assert!(
			at.len() > nth,
			"the page draws `{label}` at least {} times, drew {}",
			nth + 1,
			at.len()
		);
		session
			.click(Point { x: px(at[nth].x), y: px(at[nth].y) })
			.expect("the control is pressed");
		session
			.update(|view, _window, _cx| Pressed {
				intents: view.drain_intents(),
				notice:  view.notice().map(str::to_owned),
			})
			.expect("read back what the press did")
	})
}

/// The profile intents a press raised, which is what this suite asserts on.
fn profile_intents(pressed: &Pressed) -> Vec<&Intent> {
	pressed
		.intents
		.iter()
		.filter(|intent| {
			matches!(
				intent,
				Intent::CreateProfile { .. } | Intent::RenameProfile { .. } | Intent::DeleteProfile(_)
			)
		})
		.collect()
}

#[test]
fn every_inactive_row_deletes_its_own_directory_and_the_active_row_draws_no_delete() {
	let rows = listed();
	let inactive: Vec<&ProfileView> = rows.iter().filter(|row| !row.is_active).collect();
	assert!(
		!inactive.is_empty() && rows.iter().any(|row| row.is_active),
		"the sweep needs both an active row and an inactive one, got {rows:?}"
	);
	let drawn_deletes = driven(seeded(), |session| {
		let captured = session.frame().expect("the profiles page renders");
		drawn(&captured, "Delete").len()
	});
	assert_eq!(
		drawn_deletes,
		inactive.len(),
		"the page draws one `Delete` per inactive row and none for the active one"
	);
	for (nth, row) in inactive.iter().enumerate() {
		let pressed = press(seeded(), None, "Delete", nth);
		assert_eq!(
			profile_intents(&pressed),
			vec![&Intent::DeleteProfile(row.name.clone())],
			"the {nth} `Delete` removes the directory of the row it is on"
		);
	}
}

#[test]
fn create_sends_the_named_profile_with_the_copy_items_the_switches_leave_on() {
	let settings = seeded();
	let all: Vec<String> = settings
		.profiles
		.as_ref()
		.expect("the seeded page lists profiles")
		.copy_items
		.iter()
		.map(|item| item.key.clone())
		.collect();
	assert!(!all.is_empty(), "the sweep needs at least one copy item, got none");

	let pressed = press(seeded(), Some("review"), "Create", 0);
	assert_eq!(
		profile_intents(&pressed),
		vec![&Intent::CreateProfile { name: "review".to_owned(), copy: all.clone() }],
		"a create with every switch on copies every item the host listed"
	);

	// Every switch off is the empty profile, which is the other end of the
	// same control: a create that still copied would seed a profile from a
	// page that says it copies nothing.
	let mut none_on = seeded();
	none_on.profile_copy_off = all.iter().cloned().collect();
	let pressed = press(none_on, Some("blank"), "Create", 0);
	assert_eq!(
		profile_intents(&pressed),
		vec![&Intent::CreateProfile { name: "blank".to_owned(), copy: Vec::new() }],
		"a create with every switch off copies nothing"
	);
}

#[test]
fn rename_writes_the_field_onto_the_row_it_is_on_and_leaves_the_directory_name() {
	let rows = listed();
	for (nth, row) in rows.iter().enumerate() {
		let pressed = press(seeded(), Some("Second Look"), "Rename", nth);
		assert_eq!(
			profile_intents(&pressed),
			vec![&Intent::RenameProfile {
				name:         row.name.clone(),
				display_name: "Second Look".to_owned(),
			}],
			"the {nth} `Rename` writes the field onto that row's own directory"
		);
	}
}

#[test]
fn a_name_of_nothing_raises_no_intent_and_states_why_on_the_surface() {
	for name in [None, Some(""), Some("   ")] {
		for label in ["Create", "Rename"] {
			let pressed = press(seeded(), name, label, 0);
			assert_eq!(
				profile_intents(&pressed),
				Vec::<&Intent>::new(),
				"`{label}` with the field holding {name:?} must send nothing"
			);
			assert!(
				pressed.notice.is_some(),
				"`{label}` with the field holding {name:?} must state why it sent nothing"
			);
		}
	}
}

#[test]
fn a_host_that_listed_no_profile_states_that_rather_than_drawing_a_row() {
	let mut empty = seeded();
	empty.profiles = None;
	let captured = driven(empty, |session| session.frame().expect("the profiles page renders"));
	assert!(
		drawn(&captured, "Delete").is_empty() && drawn(&captured, "Rename").is_empty(),
		"a page with no listing draws no row control"
	);
	let text: String = captured
		.text_runs
		.iter()
		.map(|run| run.text.as_ref())
		.collect();
	assert!(
		text.contains("No profiles reported by host"),
		"a page with no listing states the condition, drew {text}"
	);
}
