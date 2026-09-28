//! A horizontal tab strip whose selected underline slides between tabs.

use std::{cell::RefCell, rc::Rc};

use veyyon_gpui::{
	AnyElement, AnyView, App, Bounds, ClickEvent, Context, EventEmitter, FocusHandle, Focusable,
	IntoElement, KeyDownEvent, Pixels, Render, SharedString, Window, div,
	motion::{Animator, FrameInstant, MotionDriver},
	prelude::*,
	px,
};

use super::drive;
use crate::theme::{ActiveTheme, Palette, TypeStyled, motion, radius, size, space, text};

/// One tab of a [`Tabs`] strip.
#[derive(Clone, Debug)]
pub struct Tab {
	label:    SharedString,
	closable: bool,
}

impl Tab {
	/// A tab showing `label`, without a close button.
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self { label: label.into(), closable: false }
	}

	/// Shows a close button after the label.
	pub const fn closable(mut self, closable: bool) -> Self {
		self.closable = closable;
		self
	}

	/// The tab's label.
	pub const fn label(&self) -> &SharedString {
		&self.label
	}
}

/// What a tab strip reports to its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabsEvent {
	/// The tab at this index became the selected one.
	Selected(usize),
	/// The close button of the tab at this index was clicked.
	Closed(usize),
}

/// A horizontal strip of tabs with an optional trailing element.
///
/// The selected tab is underlined in the accent color. When the selection
/// moves, the underline slides from the previous tab's position and width to
/// the new tab's under [`motion::LAYOUT`]. Left and Right move the selection
/// and wrap. Closing a tab only emits [`TabsEvent::Closed`]; the owner removes
/// it with [`Tabs::set_tabs`].
pub struct Tabs {
	items:    Vec<Tab>,
	selected: usize,
	trailing: Option<AnyView>,
	focus:    FocusHandle,
	/// Bounds of each tab at the last prepaint, in window coordinates.
	measured: Rc<RefCell<Vec<Bounds<Pixels>>>>,
	x:        Animator<FrameInstant>,
	width:    Animator<FrameInstant>,
	placed:   bool,
	slide:    bool,
	driver:   MotionDriver,
}

impl EventEmitter<TabsEvent> for Tabs {}

impl Focusable for Tabs {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Tabs {
	/// A strip of `tabs` with the tab at `selected` selected.
	pub fn new(tabs: Vec<Tab>, selected: usize, cx: &mut Context<Self>) -> Self {
		Self {
			selected: selected.min(tabs.len().saturating_sub(1)),
			items: tabs,
			trailing: None,
			focus: cx.focus_handle(),
			measured: Rc::default(),
			x: Animator::at_rest(0.0),
			width: Animator::at_rest(0.0),
			placed: false,
			slide: false,
			driver: MotionDriver::default(),
		}
	}

	/// The tabs.
	pub fn tabs(&self) -> &[Tab] {
		&self.items
	}

	/// The index of the selected tab.
	pub const fn selected(&self) -> usize {
		self.selected
	}

	/// Selects the tab at `ix`, slides the underline to it and emits
	/// [`TabsEvent::Selected`]. Does nothing for the selected tab or an index
	/// past the tabs.
	pub fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
		if ix >= self.items.len() || ix == self.selected {
			return;
		}
		self.selected = ix;
		self.slide = true;
		cx.emit(TabsEvent::Selected(ix));
		cx.notify();
	}

	/// Replaces the tabs and selects `selected` without emitting.
	pub fn set_tabs(&mut self, tabs: Vec<Tab>, selected: usize, cx: &mut Context<Self>) {
		self.selected = selected.min(tabs.len().saturating_sub(1));
		self.items = tabs;
		cx.notify();
	}

	/// Shows `trailing` at the end of the strip.
	pub fn set_trailing(&mut self, trailing: Option<AnyView>, cx: &mut Context<Self>) {
		self.trailing = trailing;
		cx.notify();
	}

	fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
		let len = self.items.len();
		if len == 0 {
			return;
		}
		let target = match event.keystroke.key.as_str() {
			"right" => (self.selected + 1) % len,
			"left" => (self.selected + len - 1) % len,
			_ => return,
		};
		self.select(target, cx);
		cx.stop_propagation();
	}

	/// Moves the underline toward the selected tab's measured bounds: it
	/// springs after a selection change and lands at once after a layout
	/// change.
	fn place_indicator(&mut self, cx: &App) {
		let slide = std::mem::take(&mut self.slide);
		let (first, tab) = {
			let measured = self.measured.borrow();
			match (measured.first(), measured.get(self.selected)) {
				(Some(first), Some(tab)) => (*first, *tab),
				_ => return,
			}
		};
		let x = f32::from(tab.left() - first.left());
		let width = f32::from(tab.size.width);
		let moved = self.x.target() != x || self.width.target() != width;
		if !self.placed || (moved && !slide) {
			self.x.snap(x);
			self.width.snap(width);
			self.placed = true;
		} else if moved {
			drive(&mut self.x, x, motion::LAYOUT, cx);
			drive(&mut self.width, width, motion::LAYOUT, cx);
		}
	}

	fn render_tab(&self, ix: usize, tab: &Tab, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let selected = ix == self.selected;
		div()
			.id(("tab", ix))
			.flex()
			.flex_none()
			.items_center()
			.gap(space::S1_5)
			.h(size::CONTROL_LG)
			.px(space::S3)
			.type_style(text::UI_MEDIUM)
			.cursor_pointer()
			.text_color(if selected { palette.text.primary } else { palette.text.muted })
			.when(!selected, |el| el.hover(|style| style.text_color(palette.text.secondary)))
			.on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
				window.focus(&this.focus, cx);
				this.select(ix, cx);
			}))
			.child(tab.label.clone())
			.when(tab.closable, |el| {
				el.child(
					div()
						.id(("tab-close", ix))
						.px(space::S0_5)
						.rounded(radius::SM)
						.text_color(palette.text.muted)
						.hover(|style| style.bg(palette.bg.hover).text_color(palette.text.primary))
						.on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
							cx.stop_propagation();
							cx.emit(TabsEvent::Closed(ix));
						}))
						.child("\u{00d7}"),
				)
			})
			.into_any_element()
	}
}

impl Render for Tabs {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.place_indicator(cx);
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.x);
		frame.track(&mut self.width);
		self.driver.end(frame, window);
		let palette = cx.theme().palette;
		let measured = Rc::clone(&self.measured);
		let row = div()
			.flex()
			.flex_none()
			.items_center()
			.on_children_prepainted(move |bounds, window, _| {
				let mut measured = measured.borrow_mut();
				if *measured != bounds {
					*measured = bounds;
					window.request_animation_frame();
				}
			})
			.children(self.items.iter().enumerate().map(|(ix, tab)| self.render_tab(ix, tab, &palette, cx)));
		div()
			.track_focus(&self.focus)
			.key_context("Tabs")
			.on_key_down(cx.listener(Self::on_key_down))
			.relative()
			.flex()
			.items_center()
			.border_b_1()
			.border_color(palette.border.subtle)
			.child(row)
			.when(self.placed && !self.items.is_empty(), |el| {
				el.child(
					div()
						.absolute()
						.bottom_0()
						.left(px(self.x.value()))
						.w(px(self.width.value()))
						.h(size::TAB_INDICATOR)
						.bg(palette.accent.base),
				)
			})
			.child(div().flex_1())
			.when_some(self.trailing.clone(), |el, trailing| el.child(trailing))
	}
}
