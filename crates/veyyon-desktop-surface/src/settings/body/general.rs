//! General settings page body rendering (§5.9).

use serde_json::Value;
use veyyon_desktop_kit::{
	ColorRole, TextRamp, TokenSet,
	controls::{NumberInput, Segmented, Select, Toggle},
	input::TextField,
};
use veyyon_desktop_model::{SettingKind, SurfaceId};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div,
};

use crate::{
	Intent, ShellView,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row_with_secondary},
	},
};

/// Renders the General configuration settings page rows.
pub fn render_general_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	if state.settings.is_empty() {
		return container.child(empty_state_row("No settings reported by host.", geometry, tokens));
	}

	let shell_state = cx.entity().read(cx).state();
	let entity = cx.entity();

	let mut rendered_count = 0;

	for (key, entry) in &state.settings {
		if entry.hidden {
			continue;
		}

		let field_id = SurfaceId::SettingsField(key.clone());
		let av = shell_state.controls.availability(&field_id);

		let control_el = match entry.kind {
			SettingKind::Boolean => {
				let current_bool = match &entry.value {
					Value::Bool(b) => *b,
					Value::String(s) => s == "true",
					_ => false,
				};
				let key_clone = key.clone();
				let ent = entity.clone();
				Toggle::new(current_bool)
					.id(ElementId::Name(format!("toggle-{key}").into()))
					.on_toggle(move |val, _win, app| {
						let () = ent.update(app, |view, cx| {
							view.dispatch(Intent::SettingChanged {
								key:   key_clone.clone(),
								value: Value::Bool(val),
							});
							cx.notify();
						});
					})
					.into_any_element()
			},
			SettingKind::Number => {
				let current_num = match &entry.value {
					Value::Number(n) => n.as_i64().unwrap_or(0),
					_ => 0,
				};
				let min_val = entry.min.as_ref().and_then(|n| n.as_i64()).unwrap_or(0);
				let max_val = entry.max.as_ref().and_then(|n| n.as_i64()).unwrap_or(100);
				let key_clone = key.clone();
				let ent = entity.clone();
				NumberInput::new(current_num)
					.id(ElementId::Name(format!("num-{key}").into()))
					.range(min_val, max_val)
					.on_change(move |val, _win, app| {
						let () = ent.update(app, |view, cx| {
							view.dispatch(Intent::SettingChanged {
								key:   key_clone.clone(),
								value: Value::Number(serde_json::Number::from(val)),
							});
							cx.notify();
						});
					})
					.into_any_element()
			},
			SettingKind::Enum => {
				let (labels, values): (Vec<String>, Vec<String>) = if !entry.options.is_empty() {
					entry
						.options
						.iter()
						.map(|o| (o.label.clone(), o.value.clone()))
						.unzip()
				} else if !entry.values.is_empty() {
					(entry.values.clone(), entry.values.clone())
				} else {
					(vec!["default".to_string()], vec!["default".to_string()])
				};

				let current_str = match &entry.value {
					Value::String(s) => s.as_str(),
					_ => "",
				};
				let selected_idx = values.iter().position(|v| v == current_str).unwrap_or(0);

				if labels.len() <= 5 {
					let key_clone = key.clone();
					let values_clone = values.clone();
					let ent = entity.clone();
					Segmented::new(labels, selected_idx)
						.id(ElementId::Name(format!("seg-{key}").into()))
						.on_change(move |idx, _win, app| {
							if let Some(val) = values_clone.get(idx) {
								let () = ent.update(app, |view, cx| {
									view.dispatch(Intent::SettingChanged {
										key:   key_clone.clone(),
										value: Value::String(val.clone()),
									});
									cx.notify();
								});
							}
						})
						.into_any_element()
				} else {
					Select::new(labels, selected_idx)
						.id(ElementId::Name(format!("sel-{key}").into()))
						.into_any_element()
				}
			},
			SettingKind::String
			| SettingKind::ModelChain
			| SettingKind::Record
			| SettingKind::Array => {
				let current_text = match &entry.value {
					Value::String(s) => s.clone(),
					other => other.to_string(),
				};
				let key_clone = key.clone();
				let ent = entity.clone();
				TextField::new(current_text)
					.id(ElementId::Name(format!("txt-{key}").into()))
					.on_change(move |val, _win, app| {
						let () = ent.update(app, |view, cx| {
							view.dispatch(Intent::SettingChanged {
								key:   key_clone.clone(),
								value: Value::String(val.to_string()),
							});
							cx.notify();
						});
					})
					.into_any_element()
			},
		};

		let is_modified = entry.value != entry.default;
		let secondary_el = if is_modified {
			let key_clone = key.clone();
			let reset_btn = div()
				.id(ElementId::Name(format!("reset-{key}").into()))
				.cursor_pointer()
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.hover(move |s| s.text_color(tokens.color(ColorRole::Foreground)))
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::ResetSetting(key_clone.clone()));
					cx.notify();
				}))
				.child("Reset");
			Some(reset_btn.into_any_element())
		} else {
			None
		};

		container = container.child(setting_row_with_secondary(
			entry.label.as_deref().unwrap_or(key),
			entry.description.as_deref(),
			control_el,
			secondary_el,
			&av,
			geometry,
			tokens,
		));
		rendered_count += 1;
	}

	if rendered_count == 0 {
		container =
			container.child(empty_state_row("No configurable settings available.", geometry, tokens));
	}

	container
}
