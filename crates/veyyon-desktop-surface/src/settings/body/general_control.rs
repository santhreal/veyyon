//! The control one General setting renders through, chosen by its schema
//! (§5.9, §8.25).
//!
//! One kind, one primitive: a boolean is a toggle; a bounded number is a
//! slider with the exact value beside it, an unbounded one a number input; a
//! two-way enum is a radio pair, a short enum a segmented control, a long one
//! a select; an array with declared choices is a checkbox per choice; a
//! record, a model chain and a free-form array are a text area; a string is a
//! text field.

use std::path::PathBuf;

use serde_json::Value;
use veyyon_desktop_kit::{
	Checkbox, CheckboxState, FilePicker, NumberInput, Radio, Row, Segmented, Select, Slider,
	SpacingStep, TextArea, TextField, Toggle,
};
use veyyon_desktop_model::{SettingEntry, SettingKind};
use veyyon_gpui::{
	AnyElement, App, Context, ElementId, Entity, IntoElement, ParentElement, Styled, div,
};

use crate::{Intent, ShellView};

/// Enum choices above this count are a select rather than a segmented
/// control; at or below `RADIO_MAX` they are radios.
const SEGMENTED_MAX: usize = 5;
const RADIO_MAX: usize = 2;

/// Dispatches a changed value for `key` through the view.
fn set_value(entity: &Entity<ShellView>, app: &mut App, key: &str, value: Value) {
	let key = key.to_owned();
	let () = entity.update(app, |view, cx| {
		view.dispatch(Intent::SettingChanged { key, value });
		cx.notify();
	});
}

/// The control for `entry`, wired to dispatch `SettingChanged` for `key`.
pub fn setting_control(key: &str, entry: &SettingEntry, cx: &Context<ShellView>) -> AnyElement {
	let entity = cx.entity();
	match entry.kind {
		SettingKind::Boolean => boolean_control(key, entry, entity),
		SettingKind::Number => number_control(key, entry, entity),
		SettingKind::Enum => enum_control(key, entry, entity),
		SettingKind::Array if !entry.options.is_empty() => checkbox_control(key, entry, entity),
		SettingKind::Record | SettingKind::ModelChain | SettingKind::Array => {
			text_area_control(key, entry, entity)
		},
		SettingKind::String if is_location_key(key) => path_control(key, entry, entity),
		SettingKind::String => text_field_control(key, entry, entity),
	}
}

fn boolean_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let current = match &entry.value {
		Value::Bool(b) => *b,
		Value::String(s) => s == "true",
		_ => false,
	};
	let key = key.to_owned();
	Toggle::new(current)
		.id(ElementId::Name(format!("toggle-{key}").into()))
		.on_toggle(move |val, _win, app| set_value(&entity, app, &key, Value::Bool(val)))
		.into_any_element()
}

/// A number with both bounds is a slider for the coarse move and a number
/// input for the exact value; without bounds the slider has no track to draw.
fn number_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let current = entry.value.as_f64().unwrap_or(0.0);
	let integral = entry.value.is_i64() || entry.value.is_u64();
	let to_value = move |val: f64| -> Value {
		if integral {
			Value::Number(serde_json::Number::from(val.round() as i64))
		} else {
			serde_json::Number::from_f64(val).map_or(Value::Null, Value::Number)
		}
	};

	let bounds = entry
		.min
		.as_ref()
		.and_then(serde_json::Number::as_f64)
		.zip(entry.max.as_ref().and_then(serde_json::Number::as_f64));

	let input_entity = entity.clone();
	let input_key = key.to_owned();
	let input = NumberInput::new(current.round() as i64)
		.id(ElementId::Name(format!("num-{key}").into()))
		.range(
			bounds.map_or(0, |(min, _)| min.round() as i64),
			bounds.map_or(100, |(_, max)| max.round() as i64),
		)
		.on_change(move |val, _win, app| {
			set_value(&input_entity, app, &input_key, to_value(val as f64));
		});

	let Some((min, max)) = bounds else {
		return input.into_any_element();
	};

	let slider_key = key.to_owned();
	let slider = Slider::new(current as f32, min as f32, max as f32)
		.id(ElementId::Name(format!("slider-{key}").into()))
		.on_change(move |val, _win, app| {
			set_value(&entity, app, &slider_key, to_value(f64::from(val)));
		});
	Row::new(SpacingStep::S2)
		.child(div().flex_1().min_w_0().child(slider))
		.child(input)
		.into_any_element()
}

/// The choices an enum offers: `(label, value)` pairs, from the labelled
/// options when the schema has them and from the bare values otherwise.
fn choices(entry: &SettingEntry) -> (Vec<String>, Vec<String>) {
	if !entry.options.is_empty() {
		entry
			.options
			.iter()
			.map(|o| (o.label.clone(), o.value.clone()))
			.unzip()
	} else if !entry.values.is_empty() {
		(entry.values.clone(), entry.values.clone())
	} else {
		(vec!["default".to_owned()], vec!["default".to_owned()])
	}
}

fn enum_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let (labels, values) = choices(entry);
	let current = entry.value.as_str().unwrap_or("");
	let selected = values.iter().position(|v| v == current).unwrap_or(0);

	if labels.len() <= RADIO_MAX {
		let mut row = Row::new(SpacingStep::S4);
		for (index, (label, value)) in labels.into_iter().zip(values).enumerate() {
			let entity = entity.clone();
			let key = key.to_owned();
			row = row.child(
				Radio::new(index == selected)
					.id(ElementId::Name(format!("radio-{key}-{value}").into()))
					.label(label)
					.on_select(move |_win, app| {
						set_value(&entity, app, &key, Value::String(value.clone()));
					}),
			);
		}
		return row.into_any_element();
	}

	if labels.len() <= SEGMENTED_MAX {
		let key = key.to_owned();
		return Segmented::new(labels, selected)
			.id(ElementId::Name(format!("seg-{key}").into()))
			.on_change(move |idx, _win, app| {
				if let Some(val) = values.get(idx) {
					set_value(&entity, app, &key, Value::String(val.clone()));
				}
			})
			.into_any_element();
	}

	Select::new(labels, selected)
		.id(ElementId::Name(format!("sel-{key}").into()))
		.into_any_element()
}

/// An array with declared choices is one checkbox per choice; a toggle adds
/// the choice to the array or takes it out, keeping the schema's order.
fn checkbox_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let chosen: Vec<&str> = entry
		.value
		.as_array()
		.map(|items| items.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default();

	let mut row = Row::new(SpacingStep::S3);
	for option in &entry.options {
		let checked = chosen.contains(&option.value.as_str());
		let state = if checked {
			CheckboxState::Checked
		} else {
			CheckboxState::Unchecked
		};
		let entity = entity.clone();
		let key = key.to_owned();
		let value = option.value.clone();
		let others: Vec<String> = entry
			.options
			.iter()
			.map(|o| o.value.clone())
			.filter(|v| chosen.contains(&v.as_str()) && *v != option.value)
			.collect();
		let order: Vec<String> = entry.options.iter().map(|o| o.value.clone()).collect();
		row = row.child(
			Checkbox::new(state)
				.id(ElementId::Name(format!("check-{key}-{value}").into()))
				.label(option.label.clone())
				.on_toggle(move |next, _win, app| {
					let mut kept = others.clone();
					if next == CheckboxState::Checked {
						kept.push(value.clone());
					}
					let array = order
						.iter()
						.filter(|v| kept.contains(v))
						.cloned()
						.map(Value::String)
						.collect();
					set_value(&entity, app, &key, Value::Array(array));
				}),
		);
	}
	div()
		.w_full()
		.overflow_hidden()
		.child(row)
		.into_any_element()
}

/// The multi-line value kinds render through the text area. The row is one
/// line tall, so the value is shown on one line and clipped at the column.
fn text_area_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let current = match &entry.value {
		Value::String(s) => s.clone(),
		other => other.to_string(),
	};
	let key = key.to_owned();
	div()
		.w_full()
		.whitespace_nowrap()
		.child(
			TextArea::new(current)
				.id(ElementId::Name(format!("area-{key}").into()))
				.rows(1)
				.on_change(move |val, _win, app| {
					set_value(&entity, app, &key, Value::String(val.to_string()));
				}),
		)
		.into_any_element()
}

fn text_field_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let current = match &entry.value {
		Value::String(s) => s.clone(),
		other => other.to_string(),
	};
	let key = key.to_owned();
	TextField::new(current)
		.id(ElementId::Name(format!("txt-{key}").into()))
		.on_change(move |val, _win, app| {
			set_value(&entity, app, &key, Value::String(val.to_string()));
		})
		.into_any_element()
}

/// Whether `key` names a filesystem location, by its last segment:
/// `session.workdir` is a directory, `profile.displayName` is not.
fn is_location_key(key: &str) -> bool {
	let last = key.rsplit('.').next().unwrap_or(key).to_ascii_lowercase();
	matches!(last.as_str(), "workdir" | "cwd" | "path" | "dir" | "directory" | "file")
		|| last.ends_with("path")
		|| last.ends_with("dir")
		|| last.ends_with("directory")
		|| last.ends_with("file")
}

/// A location is picked from the platform's prompt rather than typed: the
/// picker shows the path the setting holds and opens the chooser on click.
fn path_control(key: &str, entry: &SettingEntry, entity: Entity<ShellView>) -> AnyElement {
	let current = entry
		.value
		.as_str()
		.filter(|s| !s.is_empty())
		.map(PathBuf::from);
	let key = key.to_owned();
	FilePicker::new(current)
		.id(ElementId::Name(format!("path-{key}").into()))
		.on_browse(move |_event, _win, app| {
			let key = key.clone();
			let () = entity.update(app, |view, cx| view.pick_setting_path(key, cx));
		})
		.into_any_element()
}
