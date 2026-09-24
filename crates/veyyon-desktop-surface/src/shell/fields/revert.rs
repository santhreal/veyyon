//! What an escape on a field drops, per field.
//!
//! A revert is the opposite of a commit and reads the same two places a
//! commit does: the value the host last reported, which is what a field
//! returns to, and the editor the frame retained, which is what holds the
//! typing being dropped.

use serde_json::Value;
use veyyon_gpui::Context;

use super::FieldKey;
use crate::{Intent, ShellView, overlay::Overlay};

/// Drops what the field holds: a secret is discarded, and a setting's field
/// returns to the value the host reports on the next frame.
pub(super) fn revert_field(view: &mut ShellView, key: &FieldKey, cx: &mut Context<ShellView>) {
	let Some(field) = view.field_editors.get(key) else {
		return;
	};
	let editor = field.editor.clone();
	if let Some(field) = view.field_editors.get_mut(key) {
		field.dirty = false;
	}
	match key {
		FieldKey::AuthSecret => {
			editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
			view.field_editors.remove(key);
			view.dispatch(Intent::CancelAuthFlow, cx);
		},
		FieldKey::Setting(k) => {
			let initial = view
				.active_settings()
				.and_then(|s| s.entry(k))
				.map(|e| match &e.value {
					Value::String(s) => s.clone(),
					other => other.to_string(),
				})
				.unwrap_or_default();
			editor.update(cx, |editor, cx| editor.set_text(initial, cx));
		},
		FieldKey::SessionRename(id) => {
			let initial = view
				.state
				.row(*id)
				.map_or_else(|| view.state.title.clone(), |r| r.title.clone());
			editor.update(cx, |editor, cx| editor.set_text(initial, cx));
		},
		FieldKey::Keybinding(action) => {
			let initial = view
				.active_settings()
				.and_then(|settings| {
					settings
						.keybindings
						.iter()
						.find(|binding| &binding.action == action)
				})
				.map(|binding| binding.keys.join(", "))
				.unwrap_or_default();
			editor.update(cx, |editor, cx| editor.set_text(initial, cx));
		},
		// The console states what a row holds, so an escape returns the row to
		// the value the host reports rather than emptying it: the typing is
		// dropped, not the setup.
		FieldKey::AutoswarmField(field) => {
			let initial = view
				.state
				.overlay
				.as_ref()
				.and_then(Overlay::as_autoswarm)
				.and_then(|state| state.console.as_ref())
				.and_then(|console| console.fields.iter().find(|row| &row.id == field))
				.and_then(|row| row.text.clone())
				.unwrap_or_default();
			editor.update(cx, |editor, cx| editor.set_text(initial, cx));
		},
		FieldKey::TaskPrompt
		| FieldKey::ProcessCommand
		| FieldKey::ProcessInput
		| FieldKey::ProfileName
		| FieldKey::ShareLink => {
			editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
		},
		// The window captures Escape above the editor and widens the page
		// there, one rung per press, so this arm is what a revert from
		// anywhere else does: empty the query and the filter behind it.
		FieldKey::SettingsQuery => view.clear_settings_query(cx),
	}
	view.clear_refusal();
}
