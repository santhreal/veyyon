//! A list of actions: rows with an optional leading element, a label and a
//! shortcut hint, separated by rules and grouped under section headers.

use std::rc::Rc;

use veyyon_gpui::{
	AnyElement, App, ClickEvent, Context, EventEmitter, FocusHandle, Focusable, IntoElement,
	KeyDownEvent, MouseMoveEvent, Render, SharedString, Window, div, prelude::*,
};

use crate::{
	fonts::MONO_FAMILY,
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};

/// Builds the element drawn before a row's label, such as an icon.
pub type LeadingSlot = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// One pickable row of a [`Menu`].
#[derive(Clone)]
pub struct MenuRow {
	label:    SharedString,
	hint:     Option<SharedString>,
	leading:  Option<LeadingSlot>,
	disabled: bool,
}

impl MenuRow {
	/// An enabled row showing `label`.
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self { label: label.into(), hint: None, leading: None, disabled: false }
	}

	/// Shows `hint`, such as a keyboard shortcut, at the end of the row.
	pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
		self.hint = Some(hint.into());
		self
	}

	/// Draws the element `leading` builds before the label.
	pub fn leading(
		mut self,
		leading: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
	) -> Self {
		self.leading = Some(Rc::new(leading));
		self
	}

	/// Greys the row out and excludes it from picking and keyboard focus.
	pub const fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// The row's label.
	pub const fn label(&self) -> &SharedString {
		&self.label
	}

	/// Whether the row is disabled.
	pub const fn is_disabled(&self) -> bool {
		self.disabled
	}
}

/// One entry of a [`Menu`].
#[derive(Clone)]
pub enum MenuItem {
	/// A pickable row.
	Row(MenuRow),
	/// A horizontal rule between groups.
	Separator,
	/// A muted label above a group.
	Header(SharedString),
}

impl MenuItem {
	/// A section header showing `label`.
	pub fn header(label: impl Into<SharedString>) -> Self {
		Self::Header(label.into())
	}

	const fn pickable_row(&self) -> Option<&MenuRow> {
		match self {
			Self::Row(row) if !row.disabled => Some(row),
			_ => None,
		}
	}
}

impl From<MenuRow> for MenuItem {
	fn from(row: MenuRow) -> Self {
		Self::Row(row)
	}
}

/// What a menu reports to its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuEvent {
	/// The row at this item index was picked with Enter or a click.
	Picked(usize),
	/// Escape was pressed.
	Dismissed,
}

/// A keyboard-driven list of [`MenuItem`]s.
///
/// Up and Down move the highlight to the previous or next enabled row and
/// wrap; Home and End move it to the first or last. Typing letters moves it to
/// the next row whose label starts with the typed text. Enter picks the
/// highlighted row and Escape dismisses the menu. Separators, headers and
/// disabled rows are never highlighted.
pub struct Menu {
	items:       Vec<MenuItem>,
	highlighted: Option<usize>,
	typed:       String,
	focus:       FocusHandle,
}

impl EventEmitter<MenuEvent> for Menu {}

impl Focusable for Menu {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Menu {
	/// A menu of `items` with nothing highlighted.
	pub fn new(items: Vec<MenuItem>, cx: &mut Context<Self>) -> Self {
		Self { items, highlighted: None, typed: String::new(), focus: cx.focus_handle() }
	}

	/// The menu's items.
	pub fn items(&self) -> &[MenuItem] {
		&self.items
	}

	/// Replaces the items and clears the highlight.
	pub fn set_items(&mut self, items: Vec<MenuItem>, cx: &mut Context<Self>) {
		self.items = items;
		self.highlighted = None;
		self.typed.clear();
		cx.notify();
	}

	/// The item index of the highlighted row.
	pub const fn highlighted(&self) -> Option<usize> {
		self.highlighted
	}

	/// Highlights the row at item index `ix`. An index that is not an enabled
	/// row clears the highlight.
	pub fn highlight(&mut self, ix: Option<usize>, cx: &mut Context<Self>) {
		let ix = ix.filter(|&ix| self.is_pickable(ix));
		if self.highlighted != ix {
			self.highlighted = ix;
			cx.notify();
		}
	}

	/// Emits [`MenuEvent::Picked`] for the row at item index `ix` when it is
	/// an enabled row.
	pub fn pick(&self, ix: usize, cx: &mut Context<Self>) {
		if self.is_pickable(ix) {
			cx.emit(MenuEvent::Picked(ix));
		}
	}

	fn is_pickable(&self, ix: usize) -> bool {
		self
			.items
			.get(ix)
			.and_then(MenuItem::pickable_row)
			.is_some()
	}

	/// The next enabled row after the highlight, or before it when
	/// `forward` is false, wrapping at either end.
	fn step(&self, forward: bool) -> Option<usize> {
		let len = self.items.len();
		if len == 0 {
			return None;
		}
		let start = self
			.highlighted
			.unwrap_or(if forward { len - 1 } else { 0 });
		(1..=len)
			.map(|n| {
				if forward {
					(start + n) % len
				} else {
					(start + len - n) % len
				}
			})
			.find(|&ix| self.is_pickable(ix))
	}

	/// The first enabled row whose label starts with `folded`, searching from
	/// `from` and wrapping.
	fn find_prefix(&self, folded: &str, from: usize) -> Option<usize> {
		let len = self.items.len();
		(0..len).map(|n| (from + n) % len).find(|&ix| {
			self.items[ix]
				.pickable_row()
				.is_some_and(|row| starts_with_folded(&row.label, folded))
		})
	}

	fn type_to_select(&mut self, typed: &str, cx: &mut Context<Self>) {
		let folded: String = typed.chars().flat_map(char::to_lowercase).collect();
		let mut prefix = std::mem::take(&mut self.typed);
		prefix.push_str(&folded);
		let mut found = self.find_prefix(&prefix, self.highlighted.unwrap_or(0));
		if found.is_none() {
			prefix = folded;
			found = self.find_prefix(&prefix, self.highlighted.map_or(0, |ix| ix + 1));
		}
		self.typed = prefix;
		if found.is_some() && found != self.highlighted {
			self.highlighted = found;
			cx.notify();
		}
	}

	fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
		let keystroke = &event.keystroke;
		let modifiers = keystroke.modifiers;
		if modifiers.control || modifiers.alt || modifiers.platform {
			return;
		}
		let target = match keystroke.key.as_str() {
			"down" => self.step(true),
			"up" => self.step(false),
			"home" => (0..self.items.len()).find(|&ix| self.is_pickable(ix)),
			"end" => (0..self.items.len()).rev().find(|&ix| self.is_pickable(ix)),
			"enter" => {
				if let Some(ix) = self.highlighted {
					self.pick(ix, cx);
				}
				cx.stop_propagation();
				return;
			},
			"escape" => {
				cx.emit(MenuEvent::Dismissed);
				return;
			},
			_ => {
				let typed = keystroke
					.key_char
					.as_deref()
					.filter(|typed| !typed.is_empty() && typed.chars().all(char::is_alphanumeric));
				if let Some(typed) = typed {
					self.type_to_select(typed, cx);
					cx.stop_propagation();
				}
				return;
			},
		};
		self.typed.clear();
		if target.is_some() && target != self.highlighted {
			self.highlighted = target;
			cx.notify();
		}
		cx.stop_propagation();
	}

	fn render_row(
		&self,
		ix: usize,
		row: &MenuRow,
		palette: &Palette,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let leading = row.leading.as_ref().map(|leading| leading(window, cx));
		let color = if row.disabled {
			palette.text.faint
		} else {
			palette.text.primary
		};
		div()
			.id(("menu-row", ix))
			.flex()
			.flex_none()
			.items_center()
			.gap(space::S2)
			.h(size::MENU_ROW)
			.mx(space::S1)
			.px(space::S2)
			.rounded(radius::MD)
			.text_color(color)
			.when(self.highlighted == Some(ix), |el| el.bg(palette.bg.hover))
			.when_some(leading, |el, leading| el.child(leading))
			.child(div().flex_1().truncate().child(row.label.clone()))
			.when_some(row.hint.clone(), |el, hint| el.child(hint_chip(hint, palette)))
			.when(!row.disabled, |el| {
				el.cursor_pointer()
					.on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
						this.highlight(Some(ix), cx);
					}))
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.pick(ix, cx)))
			})
			.into_any_element()
	}
}

impl Render for Menu {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let mut list = div()
			.track_focus(&self.focus)
			.key_context("Menu")
			.on_key_down(cx.listener(Self::on_key_down))
			.flex()
			.flex_col()
			.min_w(size::MENU_MIN_WIDTH)
			.py(space::S1)
			.type_style(text::UI);
		for (ix, item) in self.items.iter().enumerate() {
			let child = match item {
				MenuItem::Row(row) => self.render_row(ix, row, &palette, window, cx),
				MenuItem::Separator => div()
					.flex_none()
					.my(space::S1)
					.h_px()
					.bg(palette.border.subtle)
					.into_any_element(),
				MenuItem::Header(label) => div()
					.px(space::S3)
					.pt(space::S2)
					.pb(space::S1)
					.type_style(text::MICRO)
					.text_color(palette.text.muted)
					.child(label.clone())
					.into_any_element(),
			};
			list = list.child(child);
		}
		list
	}
}

/// A shortcut hint drawn as a key cap.
fn hint_chip(hint: SharedString, palette: &Palette) -> impl IntoElement {
	div()
		.flex_none()
		.px(space::S1)
		.rounded(radius::SM)
		.border_1()
		.border_color(palette.border.subtle)
		.type_style(text::MICRO)
		.font_family(MONO_FAMILY)
		.text_color(palette.text.muted)
		.child(hint)
}

/// Whether `label`, lowercased, starts with `folded`, which is lowercase.
fn starts_with_folded(label: &str, folded: &str) -> bool {
	let mut label = label.chars().flat_map(char::to_lowercase);
	folded
		.chars()
		.all(|expected| label.next() == Some(expected))
}
