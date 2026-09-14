//! WHY THIS SUITE EXISTS:
//! The General settings rows drew their value into a fresh primitive on every
//! frame and passed an `on_change` callback the primitive never invoked, so a
//! string row, a record row, a model-chain row and a free-form array row all
//! accepted keystrokes that reached no host. The record-shaped rows had a
//! second defect behind that one: text that is not JSON had nowhere to be
//! refused, so the only paths available were sending prose under a key of
//! another shape or dropping it silently.
//!
//! THE CLASS THIS CLOSES:
//! A settings row whose field carries no value to `SettingChanged`, for every
//! `SettingKind` the model declares. `SettingKind::iter()` supplies the
//! variant space at run time and `rule` matches it exhaustively, so a new kind
//! fails to compile here until its answer is recorded, and the kinds that take
//! no typed field are pinned by exact equality rather than by count. Each case
//! types into the editor the drawn row registered — never one the test creates
//! — so a row that draws no editor, keys one under another name, or draws it
//! under another kind fails here.
//!
//! WHAT IT DOES NOT CATCH:
//! It does not cover `path_control`, which opens a platform picker and holds
//! no typed value, nor the palette's search slot, which is a slash-command
//! display and deliberately not an input. It reads the value out of the intent
//! the row raised rather than out of the host's config file, so a host that
//! answers `SettingChanged` by discarding it is the host suite's subject, not
//! this one's.

mod support;

use serde_json::{Value, json};
use strum::IntoEnumIterator;
use support::fields::{SETTING_KEY, driven, general_page_holds};
use veyyon_desktop_model::SettingKind;
use veyyon_desktop_scene::HeadlessSession;
use veyyon_desktop_surface::{FieldKey, Intent, ShellView};
use veyyon_gpui::{Point, px};

/// What a typed value commits as, per declared kind.
#[derive(Debug, PartialEq, Eq)]
enum Rule {
	/// The typed text is the value.
	Text,
	/// The typed text is JSON, and the value is what it parses to.
	Json,
	/// The kind takes a control that is not a typed field: a toggle, a number
	/// input or a slider, a radio pair, a segmented control or a select.
	NotTyped,
}

/// The exhaustive match that makes a new `SettingKind` fail to compile here
/// until its answer is recorded.
const fn rule(kind: SettingKind) -> Rule {
	match kind {
		SettingKind::String => Rule::Text,
		SettingKind::Record | SettingKind::ModelChain | SettingKind::Array => Rule::Json,
		SettingKind::Boolean | SettingKind::Number | SettingKind::Enum => Rule::NotTyped,
	}
}

/// Focuses the editor the drawn row registered and empties it, so what
/// follows is only what this test types.
fn focus_the_drawn_field(session: &mut HeadlessSession<'_, ShellView>) {
	session
		.update(|view, window, cx| {
			let editor = view
				.retained_field(&FieldKey::Setting(SETTING_KEY.to_owned()))
				.expect("the drawn row registered an editor under the key it holds");
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
			editor.update(cx, |editor, cx| {
				let _ = editor.take_text(cx);
			});
		})
		.expect("the row's field takes focus");
}

/// Types `text` into the row the page drew for `kind` and returns what a
/// return raised, with any refusal the window put up.
fn typed_into_setting_row(
	kind: SettingKind,
	seeded: Value,
	text: &str,
) -> (Vec<Intent>, Option<String>) {
	driven(general_page_holds(kind, seeded), |session| {
		focus_the_drawn_field(session);
		session
			.type_text(text)
			.expect("typing reaches the row's field");
		session
			.keystroke("enter")
			.expect("the row's field takes a return");
		session
			.update(|view, _window, _cx| (view.drain_intents(), view.notice().map(str::to_owned)))
			.expect("the view is read after the return")
	})
}

/// The one intent a row raises for `value`.
fn changed(value: Value) -> Vec<Intent> {
	vec![Intent::SettingChanged { key: SETTING_KEY.to_owned(), value }]
}

#[test]
fn every_typed_setting_kind_sends_the_value_the_operator_typed() {
	let mut not_typed = Vec::new();
	let mut swept = 0;
	for kind in SettingKind::iter() {
		swept += 1;
		match rule(kind) {
			Rule::Text => {
				let (raised, notice) = typed_into_setting_row(kind, json!("seeded"), "typed value");
				assert_eq!(
					raised,
					changed(json!("typed value")),
					"a {kind:?} row sends the text that was typed into it"
				);
				assert_eq!(notice, None, "a {kind:?} row that carried its value refuses nothing");
			},
			Rule::Json => {
				let (raised, notice) = typed_into_setting_row(kind, json!({}), "{\"model\": 2}");
				assert_eq!(
					raised,
					changed(json!({ "model": 2 })),
					"a {kind:?} row sends the value its text parses to, in the shape the key holds"
				);
				assert_eq!(notice, None, "a {kind:?} row that parsed its value refuses nothing");
			},
			Rule::NotTyped => not_typed.push(kind),
		}
	}
	assert_eq!(swept, 7, "the sweep read every kind the model declares, not a handful");
	assert_eq!(
		not_typed,
		vec![SettingKind::Boolean, SettingKind::Number, SettingKind::Enum],
		"exactly these kinds take a control that is not a typed field"
	);
}

#[test]
fn a_setting_whose_text_is_not_valid_json_is_refused_rather_than_stored_as_a_string() {
	let (raised, notice) = typed_into_setting_row(SettingKind::Record, json!({}), "not json at all");
	assert!(
		raised.is_empty(),
		"a record row sends nothing rather than storing prose under a key of another shape: \
		 {raised:?}"
	);
	let notice = notice.expect("the refusal is stated in the window");
	assert!(
		notice.contains(SETTING_KEY) && notice.contains("JSON"),
		"the refusal names the key and what is wrong with its value: {notice}"
	);
}

#[test]
fn a_snapshot_arriving_mid_edit_does_not_eat_a_keystroke() {
	let held = driven(general_page_holds(SettingKind::String, json!("from the host")), |session| {
		focus_the_drawn_field(session);
		session
			.type_text("half typed")
			.expect("typing reaches the row's field");
		session
			.update(|view, window, cx| {
				// The host reports its value again while the field has focus,
				// which is what a listing or another window's edit does.
				let editor = view.setting_field_editor(
					SETTING_KEY,
					SettingKind::String,
					"from the host",
					window,
					cx,
				);
				editor.read(cx).text().to_owned()
			})
			.expect("the row is redrawn from the newer snapshot")
	});
	assert_eq!(held, "half typed", "a snapshot does not overwrite a field being typed into");
}

#[test]
fn a_field_unfocused_follows_the_value_the_host_reports() {
	let drawn = driven(general_page_holds(SettingKind::String, json!("first")), |session| {
		session
			.update(|view, window, cx| {
				let editor =
					view.setting_field_editor(SETTING_KEY, SettingKind::String, "second", window, cx);
				editor.read(cx).text().to_owned()
			})
			.expect("the row is redrawn from the newer snapshot")
	});
	assert_eq!(drawn, "second", "an unfocused field draws the value the host reports");
}

/// Where in the field's drawn rect the pointer lands.
#[derive(Clone, Copy)]
enum Aim {
	/// The first pixel of the text, before the value the host reported.
	Start,
	/// The last pixel of the field, past the end of that value.
	End,
}

/// Clicks `aim` in the drawn field of a String row seeded with `host`, types
/// `text` there and returns whether the field holds focus with what the
/// return raised.
fn clicked_then_typed(aim: Aim, text: &str) -> (bool, Vec<Intent>) {
	driven(general_page_holds(SettingKind::String, json!("host")), |session| {
		session.frame().expect("the page draws a frame");
		let editor = session
			.update(|view, _window, _cx| {
				view
					.retained_field(&FieldKey::Setting(SETTING_KEY.to_owned()))
					.expect("the drawn row registered an editor under the key it holds")
			})
			.expect("the row's editor is read out of the view");
		// The click is aimed at the rect the editor drew into, so it travels
		// the window's hit test the way a pointer does rather than going
		// through the handle this test already holds.
		let rect = session
			.update(|_view, _window, cx| {
				editor
					.read(cx)
					.drawn_bounds()
					.expect("the row's field drew a rect a pointer can reach")
			})
			.expect("the field's rect is read out of the editor");
		let x = match aim {
			Aim::Start => rect.origin.x + px(1.0),
			Aim::End => rect.origin.x + rect.size.width - px(1.0),
		};
		session
			.click(Point { x, y: rect.center().y })
			.expect("the click reaches the window");
		session
			.type_text(text)
			.expect("typing follows the click into the field");
		session
			.keystroke("enter")
			.expect("the field takes a return");
		session
			.update(|view, window, cx| {
				(editor.read(cx).focus_handle().is_focused(window), view.drain_intents())
			})
			.expect("the view is read after the return")
	})
}

#[test]
fn a_click_in_a_row_field_puts_the_caret_where_the_pointer_landed() {
	let (focused, raised) = clicked_then_typed(Aim::Start, "typed ");
	assert!(focused, "a click in the field focuses the field it landed in");
	assert_eq!(
		raised,
		changed(json!("typed host")),
		"text typed after a click at the start of the value lands before it"
	);

	let (focused, raised) = clicked_then_typed(Aim::End, " typed");
	assert!(focused, "a click past the value focuses the field it landed in");
	assert_eq!(
		raised,
		changed(json!("host typed")),
		"text typed after a click past the end of the value lands after it"
	);
}
