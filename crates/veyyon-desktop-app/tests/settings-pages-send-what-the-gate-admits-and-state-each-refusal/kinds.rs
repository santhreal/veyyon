//! Every kind of setting the host declares draws a control that sends a value
//! of that kind for its own row: a switch the position it is flipped to, a
//! chip its choice, an input the text typed, parsed as the declared kind or
//! refused with the reason it is not one; and each row's reset sends its own
//! key.
//!
//! WHY: a row whose control carries no value to the host, sends prose under a
//! key of another shape, or registers under the id of the row beside it
//! changes a setting nobody picked or none at all. `SettingKind::iter()`
//! supplies the kinds and `row` matches them exhaustively, so a new kind does
//! not compile until its control is decided. The rows sit side by side on one
//! tab, each off its default so each draws a reset, and every control is
//! clicked at the centre the driver reports for it after the suite asserts no
//! two controls overlap.
//!
//! Gap: an array with declared choices takes chips, asserted by
//! `a_choice_of_an_array_setting_adds_or_drops_itself`; a free array is the
//! typed case here. A number's bounds are asserted by
//! `enter_sends_the_typed_value_as_its_type_and_states_why_other_text_is_not_one`.

use gpui::TestAppContext;
use serde_json::{Value, json};
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	HostAction, HostEvent, SettingKind, SettingsView as SettingsSection, SnapshotSection,
};

use super::harness::{Win, window};

/// How a row of a kind is driven.
enum Control {
	/// A switch at `false`, flipped on.
	Switch,
	/// A chip per declared value, the one named picked.
	Chip(&'static str),
	/// An input: `accepted` is sent as `sent`, and `refused` is stated with
	/// its reason rather than sent.
	Typed { accepted: &'static str, sent: Value, refused: Option<(&'static str, &'static str)> },
}

/// A row of `kind` held off its default, and how it is driven.
fn row(kind: SettingKind) -> (Value, Control) {
	let shape = "The value has the wrong JSON shape";
	match kind {
		SettingKind::Boolean => (json!({ "value": false, "default": true }), Control::Switch),
		SettingKind::Enum => (
			json!({ "value": "low", "default": "high", "values": ["low", "high"] }),
			Control::Chip("high"),
		),
		SettingKind::String => (json!({ "value": "a", "default": "" }), Control::Typed {
			accepted: "  plain words  ",
			sent:     json!("plain words"),
			refused:  None,
		}),
		// A model chain is a comma-separated string or a list; the host
		// splits the string.
		SettingKind::ModelChain => (json!({ "value": "opus", "default": "" }), Control::Typed {
			accepted: "opus, sonnet",
			sent:     json!("opus, sonnet"),
			refused:  None,
		}),
		SettingKind::Number => (json!({ "value": 5, "default": 1 }), Control::Typed {
			accepted: "7",
			sent:     json!(7),
			refused:  Some(("seven", "seven is not a number")),
		}),
		SettingKind::Array => (json!({ "value": ["x"], "default": [] }), Control::Typed {
			accepted: r#"["a", "b"]"#,
			sent:     json!(["a", "b"]),
			refused:  Some((r#"{"a": 1}"#, shape)),
		}),
		SettingKind::Record => (json!({ "value": { "a": 1 }, "default": {} }), Control::Typed {
			accepted: r#"{"a": 2}"#,
			sent:     json!({ "a": 2 }),
			refused:  Some(("[1]", shape)),
		}),
	}
}

fn key(kind: SettingKind) -> String {
	format!("kind.{kind:?}")
}

/// One setting of every kind on the tab `kinds`.
fn section() -> HostEvent {
	let mut entries = serde_json::Map::new();
	for kind in SettingKind::iter() {
		let (mut entry, _) = row(kind);
		let fields = [
			("source", json!("profile")),
			("type", serde_json::to_value(kind).expect("a kind serializes")),
			("label", json!(format!("A {kind:?} setting"))),
			("tab", json!("kinds")),
			("group", json!("Every kind")),
		];
		for (name, value) in fields {
			entry[name] = value;
		}
		entries.insert(key(kind), entry);
	}
	let section: SettingsSection =
		serde_json::from_value(Value::Object(entries)).expect("the settings fixture decodes");
	HostEvent::Snapshot(SnapshotSection::Settings(section))
}

/// The one request queued, answered as taken so the row draws the host's
/// value again.
fn taken(w: &mut Win<'_>) -> HostAction {
	let request = w.one();
	w.apply(vec![HostEvent::RequestSucceeded { request: request.id }]);
	request.action
}

#[gpui::test]
fn every_kind_of_row_sends_a_value_of_its_kind_for_its_own_key(app: &mut TestAppContext) {
	let mut w = window(app, vec![section()]);
	w.open("general#kinds");
	// The host answers the page's load, so a taken change leaves nothing in
	// flight and the row draws the host's value again.
	let loads = w.requests();
	w.apply(
		loads
			.iter()
			.map(|load| HostEvent::RequestSucceeded { request: load.id })
			.collect(),
	);

	let mut targets = Vec::new();
	for kind in SettingKind::iter() {
		let key = key(kind);
		targets.push(format!("settings.control:reset-{key}"));
		targets.push(match row(kind).1 {
			Control::Switch => format!("settings.control:toggle-{key}"),
			Control::Chip(choice) => format!("settings.control:choice-{key}-{choice}"),
			Control::Typed { .. } => format!("settings.field:{key}"),
		});
	}
	let drawn: Vec<_> = targets
		.iter()
		.map(|target| {
			(
				target,
				w.bounds(target)
					.unwrap_or_else(|| panic!("{target} is laid out")),
			)
		})
		.collect();
	for (at, (target, bounds)) in drawn.iter().enumerate() {
		for (other, beside) in &drawn[at + 1..] {
			assert!(!bounds.intersects(beside), "{target} is drawn apart from {other}");
		}
	}

	for kind in SettingKind::iter() {
		let key = key(kind);
		let set = |value: Value| HostAction::SetSetting { key: key.clone(), value };
		match row(kind).1 {
			Control::Switch => {
				w.click(&format!("settings.control:toggle-{key}"));
				assert_eq!(taken(&mut w), set(json!(true)), "{kind:?} sends the position flipped to");
			},
			Control::Chip(choice) => {
				w.click(&format!("settings.control:choice-{key}-{choice}"));
				assert_eq!(taken(&mut w), set(json!(choice)), "{kind:?} sends the chip picked");
			},
			Control::Typed { accepted, sent, refused } => {
				if let Some((text, reason)) = refused {
					w.submit(&key, text);
					assert_eq!(w.sent(), Vec::<HostAction>::new(), "{kind:?} sends no {text}");
					assert!(w.draws(reason), "{kind:?} states why {text} is not one");
				}
				w.submit(&key, accepted);
				assert_eq!(taken(&mut w), set(sent), "{kind:?} sends what was typed");
			},
		}
		w.click(&format!("settings.control:reset-{key}"));
		assert_eq!(taken(&mut w), HostAction::ResetSetting { key: key.clone() }, "{kind:?} resets");
	}
}
