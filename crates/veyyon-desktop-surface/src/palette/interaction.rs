//! A single keyboard, pointer, preview and confirmation path for list overlays.

use veyyon_desktop_kit::{Picker, PickerEvent};
use veyyon_gpui::Context;

use crate::{
	Intent, Overlay, ShellView,
	settings::{
		SettingsPage,
		body::themes::{ThemeChoice, theme_choices},
	},
};

impl ShellView {
	pub(crate) fn palette_item_enabled(&self, item: &super::PaletteItem) -> bool {
		match &item.kind {
			super::PaletteItemKind::Command { intent } => self.composer_action_allowed(intent),
			super::PaletteItemKind::Composer { command } => {
				let session =
					veyyon_desktop_model::SessionId::from(self.state().current_id.to_string());
				command.surface(&session).is_none_or(|id| {
					matches!(
						self.state().controls.availability(&id),
						crate::controls::Availability::Enabled | crate::controls::Availability::Unknown
					)
				})
			},
			_ => true,
		}
	}

	/// Returns false for keys and non-picker dialogs with their own input
	/// contract.
	pub fn picker_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
		if self.picker_is_occluded() {
			return false;
		}
		let event = match self.state().overlay.as_ref() {
			Some(Overlay::Palette(state)) => Picker::new(&state.rows, state.selected)
				.key(key, |index| self.palette_item_enabled(&state.items[*index])),
			Some(Overlay::Settings(state)) if state.page == SettingsPage::Themes => {
				let rows = theme_choices(state, &self.state().appearance, &self.state().controls, cx);
				Picker::new(&rows, state.selected_row.unwrap_or(0)).key(key, ThemeChoice::enabled)
			},
			_ => None,
		};
		let Some(event) = event else {
			return false;
		};
		self.apply_picker_event(event, cx);
		true
	}

	/// Pointer activation resolves the same current row and availability as
	/// Enter.
	pub fn picker_pointer(&mut self, index: usize, confirm: bool, cx: &mut Context<Self>) {
		let event = match self.state().overlay.as_ref() {
			Some(Overlay::Palette(state)) => {
				Picker::new(&state.rows, state.selected)
					.pointer(index, confirm, |index| self.palette_item_enabled(&state.items[*index]))
			},
			Some(Overlay::Settings(state)) if state.page == SettingsPage::Themes => {
				let rows = theme_choices(state, &self.state().appearance, &self.state().controls, cx);
				Picker::new(&rows, state.selected_row.unwrap_or(0)).pointer(
					index,
					confirm,
					ThemeChoice::enabled,
				)
			},
			_ => PickerEvent::Handled,
		};
		self.apply_picker_event(event, cx);
	}

	/// Hover previews do not replace the keyboard selection or commit an active
	/// theme.
	pub fn picker_preview(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
		let preview = index.and_then(|index| {
			let state = self.state().overlay.as_ref()?.as_settings()?;
			if state.page != SettingsPage::Themes {
				return None;
			}
			let rows = theme_choices(state, &self.state().appearance, &self.state().controls, cx);
			Picker::new(&rows, index)
				.selected(ThemeChoice::enabled)
				.filter(|row| !row.active)
				.and_then(|row| row.preview.clone())
		});
		self.dispatch(Intent::PreviewAppearance(preview), cx);
	}

	fn apply_picker_event(&mut self, event: PickerEvent, cx: &mut Context<Self>) {
		let index = match event {
			PickerEvent::Dismiss => {
				self.back_surface(cx);
				return;
			},
			PickerEvent::Handled => return,
			PickerEvent::Select(index) | PickerEvent::Confirm(index) => index,
		};
		if let Some(palette) = self
			.state_mut()
			.overlay
			.as_mut()
			.and_then(Overlay::as_palette_mut)
		{
			palette.selected = index;
			if matches!(event, PickerEvent::Confirm(_)) {
				self.run_palette(cx);
			}
		} else if let Some(state) = self.state().overlay.as_ref().and_then(Overlay::as_settings) {
			let rows = theme_choices(state, &self.state().appearance, &self.state().controls, cx);
			let Some(row) = rows.get(index).filter(|row| row.enabled()) else {
				return;
			};
			let preview = row.preview.clone();
			let action = row.action.clone();
			if let Some(state) = self
				.state_mut()
				.overlay
				.as_mut()
				.and_then(Overlay::as_settings_mut)
			{
				state.selected_row = Some(index);
			}
			self.picker_scroll().scroll_to_item(index);
			self.dispatch(Intent::PreviewAppearance(preview), cx);
			if matches!(event, PickerEvent::Confirm(_)) {
				self.dispatch(action, cx);
			}
		}
		cx.notify();
	}
}
