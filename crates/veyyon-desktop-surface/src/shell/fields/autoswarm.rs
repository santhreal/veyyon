//! The editors the swarm console's text rows are drawn from, and what a
//! return on one sends (§5.8).
//!
//! Only a text row carries an editor; a stepper, a toggle and a segmented row
//! send their change from the control itself. The row a preset is named in is
//! a text row like any other, and what separates it is the commit it is
//! created with: a return there saves the setup under the typed name rather
//! than setting a value the swarm runs with.

use veyyon_desktop_kit::input::Editor;
use veyyon_desktop_model::AutoswarmFieldKind;
use veyyon_gpui::{Context, Entity, Window};

use super::{Commit, FieldKey, FieldSpec};
use crate::{ShellView, overlay::Overlay};

/// One text row as the console states it: its id, what an empty one states,
/// what it holds, and whether it is the row a preset is named in.
type Row = (String, String, String, bool);

impl ShellView {
	/// The retained editor for the console row `field`, holding `current`
	/// until the operator types into it. A value the host reports while the
	/// row is unfocused replaces what it draws, so a frame of the console
	/// never eats a keystroke.
	///
	/// `saves` marks the row a preset is named in.
	pub fn autoswarm_field_editor(
		&mut self,
		field: &str,
		placeholder: &str,
		current: &str,
		saves: bool,
		window: &Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		let editor = self.field_editor(
			FieldSpec {
				key:         FieldKey::AutoswarmField(field.to_owned()),
				commit:      if saves {
					Commit::AutoswarmPreset
				} else {
					Commit::AutoswarmText
				},
				placeholder: placeholder.to_owned().into(),
				mask:        false,
				multiline:   false,
				initial:     current.to_owned(),
			},
			cx,
		);
		let key = FieldKey::AutoswarmField(field.to_owned());
		self.adopt_reported_value(&key, &editor, current, window, cx);
		editor
	}

	/// Sends what the console row `field` holds, which saves the setup under
	/// the typed name on the row a preset is named in and sets the value on
	/// every other row.
	pub fn submit_autoswarm_field(&mut self, field: &str, cx: &mut Context<Self>) {
		self.commit_field(&FieldKey::AutoswarmField(field.to_owned()), cx);
	}

	/// The editor for each text row of the open console, paired with the row
	/// id a change names, and empty while no console is open.
	pub(super) fn autoswarm_row_editors(
		&mut self,
		window: &Window,
		cx: &mut Context<Self>,
	) -> Vec<(String, Entity<Editor>)> {
		// The rows are cloned out first: the editor for one is created
		// through the same view the console is read from.
		let rows: Vec<Row> = self
			.state
			.overlay
			.as_ref()
			.and_then(Overlay::as_autoswarm)
			.and_then(|state| state.console.as_ref())
			.map(|console| {
				console
					.fields
					.iter()
					.filter(|row| row.kind == AutoswarmFieldKind::Text)
					.map(|row| {
						(
							row.id.clone(),
							row.placeholder.clone().unwrap_or_default(),
							row.text.clone().unwrap_or_default(),
							console.save_field.as_deref() == Some(row.id.as_str()),
						)
					})
					.collect()
			})
			.unwrap_or_default();
		rows
			.into_iter()
			.map(|(field, placeholder, current, saves)| {
				let editor =
					self.autoswarm_field_editor(&field, &placeholder, &current, saves, window, cx);
				(field, editor)
			})
			.collect()
	}
}
