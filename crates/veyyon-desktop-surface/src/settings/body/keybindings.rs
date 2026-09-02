//! Keybindings settings page body rendering (§5.9, §5.13).

use veyyon_desktop_kit::{Badge, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div};

use crate::{
	ShellView,
	controls::Availability,
	keymap::Keymap,
	settings::{SettingsState, row::setting_row},
};

/// Renders the Keybindings configuration page rows.
pub fn render_keybindings_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));
	let shell_state = cx.entity().read(cx).state();

	if state.keybindings.is_empty() {
		// §5.13: Keybindings capability absent -> render shipped defaults read-only.
		let keymap = Keymap::default();
		for row in keymap.rows() {
			let chip = Badge::new(&row.chord, TintRole::Plan);
			let av = Availability::Enabled;

			container = container.child(setting_row(
				&row.label,
				Some(row.scope.as_str()),
				chip,
				&av,
				geometry,
				tokens,
			));
		}
	} else {
		for binding in &state.keybindings {
			let field_id = SurfaceId::KeybindingField(binding.action.clone());
			let av = shell_state.controls.availability(&field_id);
			let chord_str = binding.keys.join(" ");
			let chip = Badge::new(chord_str, TintRole::Plan);

			container = container.child(setting_row(
				&binding.action,
				Some(&binding.source),
				chip,
				&av,
				geometry,
				tokens,
			));
		}
	}

	container
}
