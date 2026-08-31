//! Picker element tree construction and layout rendering.

use gpui::{
	AnyElement, App, ClickEvent, Div, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	ScrollHandle, SharedString, Styled, Window, div, px,
};

use super::types::{PickerGroup, PickerItem, PickerPreview};
use crate::{
	motion::RetainedKey,
	theme::{Elevation, Theme, layout, space},
	ui::{Icon, Row, Scrolls, Sheet, icon, kbd, text},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// The primary picker component for searchable overlays and lists.
#[derive(IntoElement)]
pub struct Picker {
	id:             SharedString,
	owner:          RetainedKey,
	search:         AnyElement,
	groups:         Vec<PickerGroup>,
	selected_index: usize,
	preview:        Option<PickerPreview>,
	scroll:         ScrollHandle,
	open:           bool,
	max_width:      f32,
	status:         Option<AnyElement>,
	footer:         Option<AnyElement>,
	on_dismiss:     Option<Click>,
}

impl Picker {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		search: impl IntoElement,
		scroll: ScrollHandle,
		open: bool,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			search: search.into_any_element(),
			groups: Vec::new(),
			selected_index: 0,
			preview: None,
			scroll,
			open,
			max_width: layout::SHEET,
			status: None,
			footer: None,
			on_dismiss: None,
		}
	}

	pub fn groups(mut self, groups: Vec<PickerGroup>) -> Self {
		self.groups = groups;
		self
	}

	pub fn group(mut self, group: PickerGroup) -> Self {
		self.groups.push(group);
		self
	}

	pub fn selected_index(mut self, index: usize) -> Self {
		self.selected_index = index;
		self
	}

	pub fn preview(mut self, preview: Option<PickerPreview>) -> Self {
		self.preview = preview;
		self
	}

	pub fn preview_element(mut self, element: impl IntoElement) -> Self {
		self.preview = Some(PickerPreview::new(element));
		self
	}

	pub fn max_width(mut self, width: f32) -> Self {
		self.max_width = width;
		self
	}

	pub fn status(mut self, status: impl IntoElement) -> Self {
		self.status = Some(status.into_any_element());
		self
	}

	pub fn footer(mut self, footer: impl IntoElement) -> Self {
		self.footer = Some(footer.into_any_element());
		self
	}

	pub fn on_dismiss(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_dismiss = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for Picker {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let has_preview = self.preview.is_some();
		let preview_width = self
			.preview
			.as_ref()
			.and_then(|p| p.width)
			.unwrap_or(layout::INSPECTOR_MIN);

		let sheet_width = if has_preview {
			self.max_width.max(layout::SHEET + preview_width)
		} else {
			self.max_width
		};

		let mut sheet = Sheet::new(self.id.clone(), self.owner, self.open).max_width(sheet_width);
		if let Some(dismiss) = self.on_dismiss {
			sheet = sheet.on_dismiss(move |event, win, app| dismiss(event, win, app));
		}

		let search_row = div()
			.flex()
			.items_center()
			.px(px(space::BASE))
			.pb(px(space::SNUG))
			.child(self.search);

		sheet = sheet.child(search_row);

		if let Some(status) = self.status {
			sheet = sheet.child(status);
		}

		let has_items = self.groups.iter().any(|g| !g.items.is_empty());
		if has_items {
			let results_list = render_groups(self.groups, self.selected_index, &self.scroll, cx);

			let body = if let Some(preview) = self.preview {
				let preview_pane = div()
					.w(px(preview_width))
					.min_w(px(preview_width))
					.max_w(px(preview_width))
					.h_full()
					.border_l_1()
					.border_color(theme.stroke)
					.pl(px(space::BASE))
					.overflow_hidden()
					.child(preview.element);

				div()
					.flex()
					.flex_row()
					.gap(px(space::BASE))
					.w_full()
					.max_h(px(layout::reading()))
					.child(
						div()
							.flex_1()
							.min_w(px(0.0))
							.overflow_hidden()
							.child(results_list),
					)
					.child(preview_pane)
			} else {
				div()
					.w_full()
					.max_h(px(layout::reading()))
					.child(results_list)
			};

			sheet = sheet.child(body);
		}

		let footer = if let Some(footer) = self.footer {
			footer
		} else {
			default_footer(has_items, &theme).into_any_element()
		};

		sheet.child(footer)
	}
}

fn render_groups(
	groups: Vec<PickerGroup>,
	selected: usize,
	scroll: &ScrollHandle,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let mut element = div()
		.id("picker-results")
		.flex()
		.flex_col()
		.gap(px(space::ROWS))
		.max_h(px(layout::reading()))
		.pt(px(space::SNUG));

	let mut index = 0usize;
	for (group_index, group) in groups.into_iter().enumerate() {
		if group.items.is_empty() {
			continue;
		}
		element = element.child(
			div()
				.px(px(space::BASE))
				.pt(px(if group_index == 0 {
					space::WIDE
				} else {
					space::LOOSE
				}))
				.pb(px(space::BASE))
				.child(text::overline(group.label, &theme).text_color(theme.text_muted)),
		);
		for item in group.items {
			let is_selected = index == selected;
			element = element.child(render_item(item, is_selected, &theme));
			index += 1;
		}
	}

	element
		.scrolls_y(scroll, Elevation::Overlay)
		.into_any_element()
}

fn render_item(item: PickerItem, selected: bool, theme: &Theme) -> AnyElement {
	let mut row = Row::new(item.id, item.owner, item.title)
		.gutter(true)
		.selected(selected)
		.active(item.active);

	if let Some(title_el) = item.title_element {
		row = row.title_element(title_el);
	}

	if let Some(detail) = item.detail {
		row = row.note(detail);
	}

	if let Some(icon_val) = item.icon {
		row = row.icon(icon_val);
	}

	if let Some(reason) = item.disabled_reason {
		row = row.note(reason.clone()).disabled(reason);
	} else if let Some(click) = item.on_click {
		row = row.on_click(click);
	}

	if item.active {
		row = row.child(icon::base(Icon::Check, theme.accent));
	}

	row.into_any_element()
}

fn default_footer(has_results: bool, theme: &Theme) -> Div {
	let mut hints = div()
		.flex()
		.flex_wrap()
		.items_center()
		.gap(px(space::BASE))
		.pt(px(space::SNUG))
		.child(hint("↑ ↓", "Navigate", theme));

	if has_results {
		hints = hints.child(hint("Enter", "Open", theme));
	}
	hints.child(hint("Esc", "Close", theme))
}

fn hint(keys: &str, label: &str, theme: &Theme) -> Div {
	div()
		.flex()
		.items_center()
		.gap(px(space::TIGHT))
		.child(kbd::caps(keys, theme))
		.child(text::meta(label, theme))
}
