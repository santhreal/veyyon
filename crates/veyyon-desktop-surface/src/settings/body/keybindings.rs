//! Keybindings settings page body rendering (§5.9, §5.13).

use veyyon_desktop_kit::{Kbd, KeyChord, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Div, ParentElement, Styled, div};

use crate::{
	controls::{Availability, ControlStates},
	keymap::Keymap,
	settings::{SettingsState, row::setting_row},
};

/// Renders the Keybindings configuration page rows.
pub fn render_keybindings_page(
	state: &SettingsState,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	if state.keybindings.is_empty() {
		// §5.13: Keybindings capability absent -> render shipped defaults read-only.
		let keymap = Keymap::default();
		for row in keymap.rows() {
			let chip = Kbd::chords([KeyChord::parse(&row.chord)]);
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
			let av = controls.availability(&field_id);
			let chip = Kbd::chords(binding.keys.iter().map(|key| KeyChord::parse(key)));

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
