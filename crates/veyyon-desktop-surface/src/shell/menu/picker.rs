//! Menu adapters share the picker keyboard and activation contract.

use veyyon_desktop_kit::{MenuItem, Picker, PickerEvent};
use veyyon_gpui::{Context, Window};

use crate::{Intent, ShellView, keymap::Command, menu::MenuSource, palette::PaletteMeta};

pub enum MenuAction {
	Command(Command),
	Intent(Intent),
}

impl ShellView {
	pub(crate) const fn picker_is_occluded(&self) -> bool {
		self.active_menu_source().is_some()
			|| self.detail().is_some()
			|| self.review_is_open()
			|| self.state.close_tab_prompt.is_some()
	}

	#[must_use]
	pub const fn active_menu_source(&self) -> Option<MenuSource> {
		if self.state.menu.open.is_some() {
			Some(MenuSource::Bar)
		} else if self.signal_menu.is_some() {
			Some(MenuSource::Signal)
		} else if self.turn_menu.is_some() {
			Some(MenuSource::Turn)
		} else if self.row_menu.is_some() {
			Some(MenuSource::Queue)
		} else {
			None
		}
	}

	#[must_use]
	pub fn menu_picker_selection(&self, source: MenuSource) -> usize {
		if source == MenuSource::Bar {
			self.state.menu.highlighted
		} else {
			self.palette_input.menu_selected
		}
	}

	pub(crate) fn menu_picker_rows(&self, source: MenuSource) -> Vec<(MenuItem, MenuAction)> {
		let rows = match source {
			MenuSource::Bar => {
				return self.state.menu.open.map_or_else(Vec::new, |section| {
					section
						.entries()
						.iter()
						.enumerate()
						.map(|(index, command)| {
							let mut item =
								MenuItem::new(command.label()).disabled(!self.state.menu.enabled(*command));
							if let Some(chord) = PaletteMeta::Chord(*command).chord(self.keymap()) {
								item = item.shortcut(chord);
							}
							(
								item.highlighted(index == self.state.menu.highlighted),
								MenuAction::Command(*command),
							)
						})
						.collect()
				});
			},
			MenuSource::Queue => self
				.row_menu
				.as_ref()
				.map(|menu| crate::queue::row_menu_items(menu, &self.state.controls)),
			MenuSource::Turn => self
				.turn_menu
				.as_ref()
				.map(crate::transcript::turn_menu_items),
			MenuSource::Signal => self
				.signal_menu
				.as_ref()
				.map(crate::drawer::signal_menu_items),
		};
		rows
			.unwrap_or_default()
			.into_iter()
			.enumerate()
			.map(|(index, (item, action))| {
				(
					item.highlighted(index == self.palette_input.menu_selected),
					MenuAction::Intent(action),
				)
			})
			.collect()
	}

	/// Context menus take and return the same retained focus handle as bar
	/// menus.
	pub(crate) fn sync_context_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let context_open = self
			.active_menu_source()
			.is_some_and(|source| source != MenuSource::Bar);
		if context_open && !self.palette_input.menu_focused {
			self.take_menu_focus(window, cx);
			self.palette_input.menu_focused = true;
		} else if !context_open && self.palette_input.menu_focused {
			self.return_menu_focus(window, cx);
			self.palette_input.menu_focused = false;
		}
	}

	pub fn menu_picker_key(
		&mut self,
		key: &str,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> bool {
		if self.detail().is_some() || self.review_is_open() || self.state.close_tab_prompt.is_some() {
			return false;
		}
		let Some(source) = self.active_menu_source() else {
			return false;
		};
		if source == MenuSource::Bar {
			match key {
				"left" => {
					self.dispatch(Intent::MoveMenuSection(-1), cx);
					return true;
				},
				"right" => {
					self.dispatch(Intent::MoveMenuSection(1), cx);
					return true;
				},
				_ => {},
			}
		}
		let rows = self.menu_picker_rows(source);
		let picker = Picker::new(&rows, self.menu_picker_selection(source));
		let Some(event) = picker.key(if key == "return" { "enter" } else { key }, |(row, _)| {
			!row.is_disabled && !row.is_separator
		}) else {
			return false;
		};
		self.apply_menu_picker(source, event, rows, window, cx);
		true
	}

	pub fn menu_picker_pointer(
		&mut self,
		source: MenuSource,
		index: usize,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.active_menu_source() != Some(source) {
			return;
		}
		let rows = self.menu_picker_rows(source);
		let event =
			Picker::new(&rows, self.menu_picker_selection(source))
				.pointer(index, true, |(row, _)| !row.is_disabled && !row.is_separator);
		self.apply_menu_picker(source, event, rows, window, cx);
	}

	fn apply_menu_picker(
		&mut self,
		source: MenuSource,
		event: PickerEvent,
		rows: Vec<(MenuItem, MenuAction)>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match event {
			PickerEvent::Dismiss => {
				self.dismiss_picker_menu(window, cx);
			},
			PickerEvent::Select(index) => {
				if source == MenuSource::Bar {
					self.state.menu.highlighted = index;
				} else {
					self.palette_input.menu_selected = index;
				}
			},
			PickerEvent::Confirm(index) => {
				if let Some((row, action)) = rows.into_iter().nth(index) {
					if row.is_disabled || row.is_separator {
						return;
					}
					match action {
						MenuAction::Command(command) => self.run_menu_command(command, window, cx),
						MenuAction::Intent(intent) => {
							self.dismiss_picker_menu(window, cx);
							self.dispatch(intent, cx);
						},
					}
				}
			},
			PickerEvent::Handled => {},
		}
		cx.notify();
	}

	pub(crate) fn dismiss_picker_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if !self.close_menu(window, cx) {
			self.close_signal_menu();
			self.close_turn_menu();
			self.close_row_menu();
			if self.palette_input.menu_focused {
				self.return_menu_focus(window, cx);
				self.palette_input.menu_focused = false;
			}
		}
		cx.notify();
	}
}
