//! Diagnostics settings page body rendering (§5.9).

use serde_json::Value;
use veyyon_desktop_kit::{Badge, Button, ButtonSize, ButtonVariant, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ElementId, IntoElement, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::ControlStates,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row, setting_row_with_secondary},
	},
};

/// Renders the Diagnostics telemetry and service health page rows.
pub fn render_diagnostics_page(
	state: &SettingsState,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	let Some(diag_json) = &state.diagnostics else {
		return container.child(empty_state_row(
			"No diagnostic information available.",
			geometry,
			tokens,
		));
	};

	let av = controls.availability(&SurfaceId::DiagnosticRefreshButton);

	// Refresh action row
	let refresh_btn = Button::new("Refresh")
		.id("diag-refresh-btn")
		.variant(ButtonVariant::Default)
		.size(ButtonSize::Small)
		.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
			view.dispatch(Intent::RefreshDiagnostics, cx);
		}));
	container = container.child(setting_row(
		"Diagnostics Telemetry",
		Some("System health checks, connection status, and service errors"),
		refresh_btn,
		&av,
		geometry,
		tokens,
	));

	// Render diagnostic sources
	if let Some(sources) = diag_json.get("sources").and_then(Value::as_array) {
		for source in sources {
			let name = source
				.get("name")
				.and_then(Value::as_str)
				.unwrap_or("Unknown");
			let status = source
				.get("status")
				.and_then(Value::as_str)
				.unwrap_or("unknown");
			let message = source
				.get("message")
				.and_then(Value::as_str)
				.or_else(|| source.get("last_error").and_then(Value::as_str));

			let (badge_text, tint) = match status {
				"ok" => ("OK", TintRole::Done),
				"warning" => ("Warning", TintRole::Plan),
				"error" => ("Error", TintRole::Error),
				"disabled" => ("Disabled", TintRole::Plan),
				_ => (status, TintRole::Plan),
			};

			let badge = Badge::new(badge_text, tint).into_any_element();

			if status == "error" {
				let source_name = name.to_string();
				let retry_btn = Button::new("Retry")
					.id(ElementId::Name(format!("diag-retry-{name}").into()))
					.size(ButtonSize::Small)
					.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
						view.dispatch(Intent::RetryDiagnosticSource(source_name.clone()), cx);
					}))
					.into_any_element();

				container = container.child(setting_row_with_secondary(
					name,
					message,
					retry_btn,
					Some(badge),
					&av,
					geometry,
					tokens,
				));
			} else {
				container = container.child(setting_row(name, message, badge, &av, geometry, tokens));
			}
		}
	}

	// Host system information if present
	if let Some(host) = diag_json.get("host").and_then(Value::as_object) {
		if let (Some(platform), Some(arch)) =
			(host.get("platform").and_then(Value::as_str), host.get("arch").and_then(Value::as_str))
		{
			let chip = Badge::new(format!("{platform} / {arch}"), TintRole::Plan);
			container = container.child(setting_row(
				"Host Platform",
				Some("Operating system platform and CPU architecture"),
				chip,
				&av,
				geometry,
				tokens,
			));
		}
		if let Some(uptime) = host.get("uptime_seconds").and_then(Value::as_u64) {
			let chip = Badge::new(format!("{uptime}s"), TintRole::Plan);
			container = container.child(setting_row(
				"Host Uptime",
				Some("Process uptime in seconds"),
				chip,
				&av,
				geometry,
				tokens,
			));
		}
	}

	container
}
