//! Diagnostics settings page body rendering (§5.9).

use serde_json::Value;
use veyyon_desktop_kit::{Badge, Button, ButtonSize, ButtonVariant, TintRole, TokenSet};
use veyyon_desktop_model::{SurfaceId, diagnostic_sources};
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
	// The sheet states the refusal of any control this page draws -- the
	// page's `Refresh` and a source's own `Retry` -- in one row above the
	// page (§4.4).
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
	let refresh_btn = Button::new("diag-refresh-btn", "Refresh")
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

	// One reader states what a source is, so the `Retry` this page draws and
	// the gate the projection sets for it are decided by the same rule.
	for source in diagnostic_sources(Some(diag_json)) {
		let (badge_text, tint) = match source.status {
			"ok" => ("OK", TintRole::Done),
			"warning" => ("Warning", TintRole::Plan),
			"error" => ("Error", TintRole::Error),
			"disabled" => ("Disabled", TintRole::Plan),
			other => (other, TintRole::Plan),
		};
		let badge = Badge::new(badge_text, tint).into_any_element();

		if source.offers_retry() {
			let surface = SurfaceId::DiagnosticRetrySourceButton(source.name.to_owned());
			// A source's `Retry` sends one source's request, so it reads its
			// own gate rather than the page's: a refresh in flight holds the
			// page, not every row on it.
			let row_av = controls.availability(&surface);
			let source_name = source.name.to_owned();
			let retry_btn =
				Button::new(ElementId::Name(format!("diag-retry-{}", source.name).into()), "Retry")
					.size(ButtonSize::Small)
					.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
						view.dispatch(Intent::RetryDiagnosticSource(source_name.clone()), cx);
					}))
					.into_any_element();

			container = container.child(setting_row_with_secondary(
				source.name,
				source.message,
				retry_btn,
				Some(badge),
				&row_av,
				geometry,
				tokens,
			));
		} else {
			container =
				container.child(setting_row(source.name, source.message, badge, &av, geometry, tokens));
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
