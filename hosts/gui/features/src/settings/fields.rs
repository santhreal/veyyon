//! Schema-driven fields with confirmed, default, source, pending, and error
//! state.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		CommandState, SettingDefinition, SettingEditor, SettingKind, SettingValueView, SettingsState,
		Value,
	},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Banner, Field, Fill, Group, Size, Tone, text},
};

use crate::act;

pub fn render_groups(
	store: &Store,
	state: &SettingsState,
	definitions: &[&SettingDefinition],
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let mut groups: Vec<(&str, Vec<&SettingDefinition>)> = Vec::new();
	for definition in definitions {
		if !definition.visible || definition.unavailable_reason.is_some() {
			continue;
		}
		if let Some((_, fields)) = groups
			.iter_mut()
			.find(|(name, _)| *name == definition.group)
		{
			fields.push(definition);
		} else {
			groups.push((&definition.group, vec![definition]));
		}
	}
	if groups.is_empty() {
		return veyyon_gui_kit::ui::Empty::new("No settings in this section")
			.note("Unsupported conditional fields are hidden.")
			.into_any_element();
	}
	let mut page = text::stack(space::LOOSE);
	for (name, definitions) in groups {
		let mut group = Group::new(name.to_owned());
		for definition in definitions {
			group = group.child(field(store, state, definition, mutable, cx));
		}
		page = page.child(group);
	}
	page.into_any_element()
}

fn field(
	store: &Store,
	state: &SettingsState,
	definition: &SettingDefinition,
	mutable: bool,
	cx: &mut App,
) -> Field {
	let confirmed = current(state, definition);
	let command = store.command_state(&CommandTarget::Settings(Some(definition.path.clone())));
	let mut field = Field::new(definition.label.clone()).stacked();
	if let Some(description) = &definition.description {
		field = field.note(description.clone());
	}
	field = field.child(control(definition, confirmed, mutable, &command, cx));
	let mut metadata = div().flex().flex_wrap().items_center().gap(px(space::SNUG));
	metadata = metadata.child(Badge::new(format!(
		"Current: {}",
		confirmed
			.map(|value| display_value(&value.value, definition.secret))
			.unwrap_or_else(|| "Not reported".to_owned())
	)));
	metadata = metadata.child(Badge::new(format!(
		"Default: {}",
		display_value(&definition.default, definition.secret)
	)));
	if let Some(source) = confirmed.and_then(|value| value.provenance.as_deref()) {
		metadata = metadata.child(Badge::new(format!("Source: {source}")).bare());
	}
	field = field.child(metadata);
	if let Some(message) = validation(state, definition) {
		field = field.child(Banner::failure("This value is invalid").detail(message.to_owned()));
	}
	match command {
		CommandState::Pending { .. } => {
			field = field.child(Badge::new("Saving").tone(Tone::Warn));
		},
		CommandState::Failed { message, .. } => {
			field = field.child(Banner::failure("This setting was not saved").detail(message));
		},
		CommandState::Idle => {},
	}
	field
}

fn control(
	definition: &SettingDefinition,
	confirmed: Option<&SettingValueView>,
	mutable: bool,
	command: &CommandState,
	_cx: &mut App,
) -> AnyElement {
	let pending = matches!(command, CommandState::Pending { .. });
	if definition.read_only || definition.editor == SettingEditor::ReadOnly {
		return confirmed
			.map(|value| {
				Badge::new(display_value(&value.value, definition.secret))
					.exact()
					.into_any_element()
			})
			.unwrap_or_else(|| {
				Badge::new("Current value unavailable")
					.tone(Tone::Warn)
					.into_any_element()
			});
	}
	match (&definition.editor, &definition.kind, confirmed.map(|value| &value.value)) {
		(SettingEditor::Toggle, SettingKind::Boolean, Some(Value::Bool(value))) => {
			let mut switch =
				crate::settings::controls::switch(format!("setting-{}", definition.path.0), *value);
			if mutable && !pending {
				switch = switch.on_click(act::click(UiCommand::SetSetting {
					path:  definition.path.clone(),
					value: Value::Bool(!value),
				}));
			} else if pending {
				switch = switch.disabled("Setting change is pending");
			} else {
				switch = switch.disabled("Settings are read-only");
			}
			switch.into_any_element()
		},
		(SettingEditor::Select, SettingKind::Choice, Some(current))
			if !definition.choices.is_empty() =>
		{
			let mut choices = div().flex().flex_wrap().gap(px(space::SNUG));
			for choice in &definition.choices {
				let selected = choice == current;
				let mut btn = crate::settings::controls::button(
					format!("setting-{}-{}", definition.path.0, display_value(choice, false)),
					display_value(choice, false),
				)
				.fill(if selected { Fill::Tinted } else { Fill::Ghost })
				.tone(if selected { Tone::Accent } else { Tone::Muted })
				.on(selected)
				.size(Size::Small);
				if pending {
					btn = btn.disabled("Setting change is pending");
				} else if !mutable {
					btn = btn.disabled("Settings are read-only");
				} else {
					btn = btn.on_click(act::click(UiCommand::SetSetting {
						path:  definition.path.clone(),
						value: choice.clone(),
					}));
				}
				choices = choices.child(btn);
			}
			choices.into_any_element()
		},
		(
			SettingEditor::Stepper | SettingEditor::Slider,
			SettingKind::Integer | SettingKind::Number,
			Some(Value::Number(value)),
		) => numeric_control(definition, value, mutable && !pending),
		(_, _, Some(value)) => {
			let is_default = value == &definition.default;
			let mut row = div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.child(Badge::new(display_value(value, definition.secret)).exact());
			if !is_default {
				let mut reset_btn = crate::settings::controls::button(
					format!("reset-setting-{}", definition.path.0),
					"Reset",
				)
				.fill(Fill::Ghost)
				.size(Size::Small);
				if pending {
					reset_btn = reset_btn.disabled("Setting change is pending");
				} else if !mutable {
					reset_btn = reset_btn.disabled("Settings are read-only");
				} else {
					reset_btn =
						reset_btn.on_click(act::click(UiCommand::ResetSetting(definition.path.clone())));
				}
				row = row.child(reset_btn);
			}
			row.into_any_element()
		},
		(_, _, None) => Badge::new("Current value unavailable")
			.tone(Tone::Warn)
			.into_any_element(),
	}
}

fn numeric_control(definition: &SettingDefinition, printed: &str, mutable: bool) -> AnyElement {
	let Some(current) = printed.parse::<f64>().ok() else {
		return Badge::new("Invalid numeric value")
			.tone(Tone::Danger)
			.into_any_element();
	};
	let Some(step) = definition.step.as_ref().and_then(number) else {
		return Badge::new(printed.to_owned()).exact().into_any_element();
	};
	let minimum = definition.minimum.as_ref().and_then(number);
	let maximum = definition.maximum.as_ref().and_then(number);
	let down_value = current - step;
	let up_value = current + step;
	let down = mutable && minimum.is_none_or(|minimum| down_value >= minimum);
	let up = mutable && maximum.is_none_or(|maximum| up_value <= maximum);
	let mut stepper = crate::settings::controls::stepper(
		format!("setting-{}", definition.path.0),
		printed.to_owned(),
	)
	.limits(down, up);
	if down {
		stepper = stepper.on_down(act::click(UiCommand::SetSetting {
			path:  definition.path.clone(),
			value: Value::Number(format_number(down_value, &definition.kind)),
		}));
	}
	if up {
		stepper = stepper.on_up(act::click(UiCommand::SetSetting {
			path:  definition.path.clone(),
			value: Value::Number(format_number(up_value, &definition.kind)),
		}));
	}
	stepper.into_any_element()
}

fn number(value: &Value) -> Option<f64> {
	match value {
		Value::Number(value) => value.parse().ok(),
		_ => None,
	}
}

fn format_number(value: f64, kind: &SettingKind) -> String {
	if matches!(kind, SettingKind::Integer) {
		format!("{value:.0}")
	} else {
		let mut printed = format!("{value:.6}");
		while printed.contains('.') && printed.ends_with('0') {
			printed.pop();
		}
		if printed.ends_with('.') {
			printed.pop();
		}
		printed
	}
}

fn current<'a>(
	state: &'a SettingsState,
	definition: &SettingDefinition,
) -> Option<&'a SettingValueView> {
	state
		.effective_values
		.iter()
		.find(|value| value.path == definition.path)
}

fn validation<'a>(state: &'a SettingsState, definition: &SettingDefinition) -> Option<&'a str> {
	state
		.validation
		.iter()
		.find_map(|(path, message)| (path == &definition.path).then_some(message.as_str()))
}

fn display_value(value: &Value, secret: bool) -> String {
	if secret {
		return "Stored securely".to_owned();
	}
	match value {
		Value::Null => "None".to_owned(),
		Value::Bool(value) => if *value { "On" } else { "Off" }.to_owned(),
		Value::Number(value) | Value::String(value) => value.clone(),
		Value::Array(values) => format!("{} values", values.len()),
		Value::Object(fields) => format!("{} fields", fields.len()),
		Value::Opaque { media_type, .. } => format!("{media_type} data"),
	}
}
