//! MCP settings page body rendering (§5.9).

use veyyon_desktop_kit::{Badge, TintRole, TokenSet, controls::Toggle};
use veyyon_desktop_model::{McpServerStatus, SurfaceId};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Context, Div, ElementId, IntoElement, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::ControlStates,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row_with_secondary},
	},
};

/// Renders the Model Context Protocol servers configuration page rows.
pub fn render_mcp_page(
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

	if state.mcp.is_empty() {
		return container.child(empty_state_row("No MCP servers configured.", geometry, tokens));
	}

	let entity = cx.entity();

	for server in &state.mcp {
		let av = controls.availability(&SurfaceId::McpEnableToggle(server.name.clone()));

		let (status_text, status_tint) = match &server.status {
			McpServerStatus::Connected => ("Connected".to_string(), TintRole::Done),
			McpServerStatus::Connecting => ("Connecting".to_string(), TintRole::Plan),
			McpServerStatus::Disconnected => ("Disconnected".to_string(), TintRole::Plan),
			McpServerStatus::Error { message } => (format!("Error: {message}"), TintRole::Error),
		};
		let status_badge = Badge::new(status_text, status_tint).into_any_element();

		let s_name = server.name.clone();
		let ent = entity.clone();
		let toggle = Toggle::new(server.enabled)
			.id(ElementId::Name(format!("mcp-toggle-{}", server.name).into()))
			.on_toggle(move |val, _win, app| {
				let () = ent.update(app, |view, cx| {
					view.dispatch(Intent::SetMcpEnabled { server: s_name.clone(), enabled: val });
					cx.notify();
				});
			})
			.into_any_element();

		let desc = if server.tools.is_empty() {
			"0 tools exposed".to_string()
		} else {
			format!("{} tools: {}", server.tools.len(), server.tools.join(", "))
		};

		container = container.child(setting_row_with_secondary(
			&server.name,
			Some(&desc),
			toggle,
			Some(status_badge),
			&av,
			geometry,
			tokens,
		));
	}

	container
}
