//! Setting values as the General page's inputs show and send them: the text
//! an input shows for a value, the value typed text parses to, and keeping
//! the inputs in step with the host.

use serde_json::Value;
use veyyon_desktop_model::{HostAction, SettingEntry, SettingKind, SurfaceId};
use veyyon_desktop_ui::editor::Editor;
use veyyon_gpui::{Context, Entity, Focusable as _, SharedString, Window};

use super::SettingsView;

impl SettingsView {
	/// Shows each setting's current value in its input unless the input holds
	/// focus, so a value reset or set elsewhere replaces the text drawn.
	pub(super) fn sync_setting_fields(&self, window: &Window, cx: &mut Context<Self>) {
		let Some(settings) = &self.app.read(cx).store().domains.settings else {
			return;
		};
		let stale: Vec<(Entity<Editor>, String)> = self
			.fields
			.iter()
			.filter_map(|(key, field)| {
				let text = value_text(&settings.get(key)?.value);
				let shown = field.input.read(cx).text() == text;
				let typing = field.input.focus_handle(cx).is_focused(window);
				(!shown && !typing).then(|| (field.input.clone(), text))
			})
			.collect();
		for (input, text) in stale {
			input.update(cx, |input, cx| input.set_text(&text, cx));
		}
	}
}

/// A setting's value as its input shows it: a string bare, nothing for
/// null, JSON for the rest.
pub(super) fn value_text(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		Value::Null => String::new(),
		other => other.to_string(),
	}
}

/// Sends the value typed for `key`, parsed as the setting's declared type,
/// or states under the setting why the text is not one.
pub(super) fn submit_setting(
	view: &mut SettingsView,
	key: &str,
	text: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	let declared = view
		.app
		.read(cx)
		.store()
		.domains
		.settings
		.as_ref()
		.and_then(|settings| settings.get(key))
		.map(|entry| (entry.kind, Bounds::of(entry)));
	let Some((kind, bounds)) = declared else {
		return;
	};
	match parse(kind, bounds, &text) {
		Ok(value) => {
			view.errors.remove(key);
			view.send(
				HostAction::SetSetting { key: key.to_owned(), value },
				SurfaceId::SettingsField(key.to_owned()),
				cx,
			);
		},
		Err(error) => {
			view.errors.insert(key.to_owned(), error);
		},
	}
	cx.notify();
}

/// The inclusive range a `Number` setting declares.
#[derive(Clone, Copy, Debug)]
struct Bounds {
	min: Option<f64>,
	max: Option<f64>,
}

impl Bounds {
	fn of(entry: &SettingEntry) -> Self {
		Self {
			min: entry.min.as_ref().and_then(serde_json::Number::as_f64),
			max: entry.max.as_ref().and_then(serde_json::Number::as_f64),
		}
	}
}

/// `text` as a value of `kind`, or why it is not one. A whole number is sent
/// as one, and a number outside `bounds` is not a value.
fn parse(kind: SettingKind, bounds: Bounds, text: &str) -> Result<Value, SharedString> {
	let trimmed = text.trim();
	match kind {
		SettingKind::String | SettingKind::ModelChain | SettingKind::Enum => {
			Ok(Value::String(trimmed.to_owned()))
		},
		SettingKind::Boolean => match trimmed {
			"true" => Ok(Value::Bool(true)),
			"false" => Ok(Value::Bool(false)),
			_ => Err("Type true or false".into()),
		},
		SettingKind::Number => {
			let number = trimmed
				.parse::<i64>()
				.map(serde_json::Number::from)
				.ok()
				.or_else(|| {
					trimmed
						.parse::<f64>()
						.ok()
						.and_then(serde_json::Number::from_f64)
				})
				.ok_or_else(|| SharedString::from(format!("{trimmed} is not a number")))?;
			let value = number.as_f64().unwrap_or_default();
			if let Some(min) = bounds.min.filter(|min| value < *min) {
				return Err(format!("The lowest value is {min}").into());
			}
			if let Some(max) = bounds.max.filter(|max| value > *max) {
				return Err(format!("The highest value is {max}").into());
			}
			Ok(Value::Number(number))
		},
		SettingKind::Array | SettingKind::Record => {
			let value: Value = serde_json::from_str(trimmed)
				.map_err(|error| SharedString::from(format!("Not JSON: {error}")))?;
			let fits = match kind {
				SettingKind::Array => value.is_array(),
				_ => value.is_object(),
			};
			if fits {
				Ok(value)
			} else {
				Err("The value has the wrong JSON shape".into())
			}
		},
	}
}
