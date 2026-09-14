//! Selection, keyboard and row presentation over caller-provided picker rows.
//! Matching, previews and actions remain with the data adapter.

use veyyon_gpui::ElementId;

use crate::{ListRow, SelectionState};

/// One interaction resolved against the current source, never a cached action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerEvent {
	Select(usize),
	Confirm(usize),
	Dismiss,
	Handled,
}

/// Borrowed list mechanics shared by searchable overlays and settings choices.
/// Disabled rows remain readable but cannot be selected or confirmed.
pub struct Picker<'a, T> {
	rows:     &'a [T],
	selected: usize,
}

impl<'a, T> Picker<'a, T> {
	#[must_use]
	pub const fn new(rows: &'a [T], selected: usize) -> Self {
		Self { rows, selected }
	}

	#[must_use]
	pub fn selected(&self, enabled: impl Fn(&T) -> bool) -> Option<&'a T> {
		self.rows.get(self.selected).filter(|row| enabled(row))
	}

	/// Arrow navigation wraps; pages and endpoints stop at the list boundary.
	#[must_use]
	pub fn key(&self, key: &str, enabled: impl Fn(&T) -> bool) -> Option<PickerEvent> {
		let event = match key {
			"escape" => PickerEvent::Dismiss,
			"enter" => self
				.selected(&enabled)
				.map_or(PickerEvent::Handled, |_| PickerEvent::Confirm(self.selected)),
			"up" => self.step(-1, &enabled),
			"down" => self.step(1, &enabled),
			"pageup" => self.seek(self.selected.saturating_sub(8), -1, &enabled),
			"pagedown" => self.seek(
				self
					.selected
					.saturating_add(8)
					.min(self.rows.len().saturating_sub(1)),
				1,
				&enabled,
			),
			"home" => self.seek(0, 1, &enabled),
			"end" => self.seek(self.rows.len().saturating_sub(1), -1, &enabled),
			_ => return None,
		};
		Some(event)
	}

	#[must_use]
	pub fn pointer(&self, index: usize, confirm: bool, enabled: impl Fn(&T) -> bool) -> PickerEvent {
		if self.rows.get(index).is_none_or(|row| !enabled(row)) {
			PickerEvent::Handled
		} else if confirm {
			PickerEvent::Confirm(index)
		} else {
			PickerEvent::Select(index)
		}
	}

	#[must_use]
	pub fn step(&self, delta: i32, enabled: impl Fn(&T) -> bool) -> PickerEvent {
		let count = self.rows.len();
		if count == 0 {
			return PickerEvent::Handled;
		}
		let direction = if delta < 0 { -1 } else { 1 };
		let first = (self.selected.min(count - 1) as i64 + i64::from(delta)).rem_euclid(count as i64);
		for offset in 0..count {
			let index = (first + offset as i64 * direction).rem_euclid(count as i64) as usize;
			if enabled(&self.rows[index]) {
				return PickerEvent::Select(index);
			}
		}
		PickerEvent::Handled
	}

	fn seek(&self, start: usize, direction: i32, enabled: impl Fn(&T) -> bool) -> PickerEvent {
		let count = self.rows.len();
		if count == 0 {
			return PickerEvent::Handled;
		}
		let start = start.min(count - 1);
		let forward = if direction < 0 {
			(0..=start).rev().find(|index| enabled(&self.rows[*index]))
		} else {
			(start..count).find(|index| enabled(&self.rows[*index]))
		};
		let index = forward.or_else(|| {
			if direction < 0 {
				(start..count).find(|index| enabled(&self.rows[*index]))
			} else {
				(0..=start).rev().find(|index| enabled(&self.rows[*index]))
			}
		});
		index.map_or(PickerEvent::Handled, PickerEvent::Select)
	}

	#[must_use]
	pub fn selection(&self, index: usize, enabled: impl Fn(&T) -> bool) -> SelectionState {
		if index == self.selected && self.rows.get(index).is_some_and(enabled) {
			SelectionState::Selected
		} else {
			SelectionState::None
		}
	}

	/// Token-driven row presentation; the caller adds domain badges and actions.
	#[must_use]
	pub fn row(
		&self,
		index: usize,
		id: impl Into<ElementId>,
		title: impl Into<veyyon_gpui::SharedString>,
		enabled: impl Fn(&T) -> bool,
	) -> ListRow {
		ListRow::new(id, title).selection(self.selection(index, enabled))
	}

	/// Keeps the selected row visible within the same eight-row page budget.
	#[must_use]
	pub fn window_start(
		&self,
		room: f32,
		row_height: f32,
		header_height: f32,
		group: impl Fn(&T) -> Option<&str>,
	) -> usize {
		if self.rows.is_empty() {
			return 0;
		}
		let selected = self.selected.min(self.rows.len() - 1);
		let mut start = selected;
		let mut rows = row_height;
		while start > 0 && selected - start < 7 {
			let above = start - 1;
			let mut next = rows + row_height;
			if group(&self.rows[start]) != group(&self.rows[above]) {
				next += header_height;
			}
			let top = if group(&self.rows[above]).is_some() {
				header_height
			} else {
				0.0
			};
			if next + top > room {
				break;
			}
			rows = next;
			start = above;
		}
		start
	}
}
