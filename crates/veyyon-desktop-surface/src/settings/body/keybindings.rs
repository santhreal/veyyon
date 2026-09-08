//! Keybindings settings page body rendering (§5.9, §5.13).

use veyyon_desktop_kit::{Kbd, KeyChord, TextField, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Div, ElementId, IntoElement, ParentElement, Styled, div};

use crate::{
	controls::{Availability, ControlStates},
	keymap::Keymap,
	settings::{SettingsState, row::setting_row},
	shell::fields::FieldSlots,
};

/// Renders the Keybindings configuration page rows.
pub fn render_keybindings_page(
	state: &SettingsState,
	fields: &FieldSlots,
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
			// The chords a press has to match are what the field states, so
			// the row is the editor rather than a chip beside one. A host
			// that reports a binding the window has not drawn a field for
			// yet states it as the chip, which is what it can still show.
			let control = fields.keybinding(&binding.action).map_or_else(
				|| Kbd::chords(binding.keys.iter().map(|key| KeyChord::parse(key))).into_any_element(),
				|editor| {
					TextField::new(editor)
						.id(ElementId::Name(format!("kbd-{}", binding.action).into()))
						.into_any_element()
				},
			);

			container = container.child(setting_row(
				&binding.action,
				Some(&binding.source),
				control,
				&av,
				geometry,
				tokens,
			));
		}
	}

	container
}
