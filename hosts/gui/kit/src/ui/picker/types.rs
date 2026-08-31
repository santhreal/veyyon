//! Item, group, and preview types for the picker primitive.

use gpui::{AnyElement, App, ClickEvent, IntoElement, SharedString, Window};

use crate::{motion::RetainedKey, ui::Icon};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One result item inside a picker group.
pub struct PickerItem {
	pub id:              SharedString,
	pub owner:           RetainedKey,
	pub title:           SharedString,
	pub title_element:   Option<AnyElement>,
	pub detail:          Option<SharedString>,
	pub icon:            Option<Icon>,
	pub disabled_reason: Option<SharedString>,
	pub selected:        bool,
	pub active:          bool,
	pub on_click:        Option<Click>,
	pub on_alternate:    Option<Click>,
}

impl PickerItem {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		title: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			title: title.into(),
			title_element: None,
			detail: None,
			icon: None,
			disabled_reason: None,
			selected: false,
			active: false,
			on_click: None,
			on_alternate: None,
		}
	}

	pub fn title_element(mut self, element: impl IntoElement) -> Self {
		self.title_element = Some(element.into_any_element());
		self
	}

	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	pub fn disabled(mut self, reason: impl Into<SharedString>) -> Self {
		self.disabled_reason = Some(reason.into());
		self
	}

	pub fn selected(mut self, selected: bool) -> Self {
		self.selected = selected;
		self
	}

	pub fn active(mut self, active: bool) -> Self {
		self.active = active;
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(listener));
		self
	}

	pub fn on_alternate(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_alternate = Some(Box::new(listener));
		self
	}
}

/// A labeled section of picker items.
pub struct PickerGroup {
	pub id:    SharedString,
	pub label: SharedString,
	pub items: Vec<PickerItem>,
}

impl PickerGroup {
	pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
		Self { id: id.into(), label: label.into(), items: Vec::new() }
	}

	pub fn item(mut self, item: PickerItem) -> Self {
		self.items.push(item);
		self
	}

	pub fn items(mut self, items: impl IntoIterator<Item = PickerItem>) -> Self {
		self.items.extend(items);
		self
	}
}

/// An optional preview pane rendered alongside the list for the item under the
/// cursor.
pub struct PickerPreview {
	pub element: AnyElement,
	pub width:   Option<f32>,
}

impl PickerPreview {
	pub fn new(element: impl IntoElement) -> Self {
		Self { element: element.into_any_element(), width: None }
	}

	pub fn width(mut self, width: f32) -> Self {
		self.width = Some(width);
		self
	}
}
