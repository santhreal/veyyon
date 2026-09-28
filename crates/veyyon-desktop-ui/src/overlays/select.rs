//! A control showing the current value that opens a [`Menu`] of the options.

use std::{cell::Cell, rc::Rc};

use veyyon_gpui::{
	Anchor, App, Bounds, ClickEvent, Context, Entity, EventEmitter, FocusHandle, Focusable,
	IntoElement, KeyDownEvent, Pixels, Render, SharedString, Subscription, Window, div, point,
	prelude::*,
};

use super::{Menu, MenuEvent, MenuItem, MenuRow, Popover, PopoverEvent};
use crate::{
	controls::hover_transition,
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

/// What a select reports to its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectEvent {
	/// The option at this index was picked.
	Changed(usize),
}

/// A trigger showing the selected option that opens a [`Menu`] of options.
///
/// The trigger shows the selected option's label, or the placeholder while
/// nothing is selected. Click, Enter, Space and Down open the menu below the
/// trigger; picking an option closes it and emits [`SelectEvent::Changed`].
pub struct Select {
	labels:         Vec<SharedString>,
	selected:       Option<usize>,
	placeholder:    SharedString,
	menu:           Entity<Menu>,
	popover:        Entity<Popover>,
	trigger_bounds: Rc<Cell<Bounds<Pixels>>>,
	focus:          FocusHandle,
	_subscriptions: [Subscription; 2],
}

impl EventEmitter<SelectEvent> for Select {}

impl Focusable for Select {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Select {
	/// A select over `options` with `selected` chosen, showing `placeholder`
	/// while nothing is.
	pub fn new(
		options: Vec<MenuRow>,
		selected: Option<usize>,
		placeholder: impl Into<SharedString>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Self {
		let labels: Vec<SharedString> = options.iter().map(|row| row.label().clone()).collect();
		let selected = selected.filter(|&ix| ix < labels.len());
		let items = options.into_iter().map(MenuItem::from).collect();
		let menu = cx.new(|cx| Menu::new(items, cx));
		let popover = cx.new(|cx| Popover::new(&menu, cx));
		let subscriptions = [
			cx.subscribe_in(&menu, window, Self::on_menu_event),
			cx.subscribe(&popover, |_, _, _: &PopoverEvent, cx| cx.notify()),
		];
		Self {
			labels,
			selected,
			placeholder: placeholder.into(),
			menu,
			popover,
			trigger_bounds: Rc::default(),
			focus: cx.focus_handle(),
			_subscriptions: subscriptions,
		}
	}

	/// The index of the selected option.
	pub const fn selected(&self) -> Option<usize> {
		self.selected
	}

	/// Selects the option at `ix`; an index past the options clears the
	/// selection. Emits nothing.
	pub fn set_selected(&mut self, ix: Option<usize>, cx: &mut Context<Self>) {
		let ix = ix.filter(|&ix| ix < self.labels.len());
		if self.selected != ix {
			self.selected = ix;
			cx.notify();
		}
	}

	/// Opens the options below the trigger with the selected one
	/// highlighted, or closes them when they are open.
	pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.popover.read(cx).is_open() {
			self
				.popover
				.update(cx, |popover, cx| popover.close(window, cx));
			return;
		}
		let selected = self.selected;
		self
			.menu
			.update(cx, |menu, cx| menu.highlight(selected, cx));
		let trigger = self.trigger_bounds.get();
		let position = trigger.bottom_left() + point(space::S0, space::S1);
		self.popover.update(cx, |popover, cx| {
			popover.open(position, Anchor::TopLeft, Some(trigger), window, cx);
		});
		cx.notify();
	}

	fn on_menu_event(
		&mut self,
		_: &Entity<Menu>,
		event: &MenuEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if let MenuEvent::Picked(ix) = *event {
			self.set_selected(Some(ix), cx);
			cx.emit(SelectEvent::Changed(ix));
		}
		self
			.popover
			.update(cx, |popover, cx| popover.close(window, cx));
	}

	fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
		if matches!(event.keystroke.key.as_str(), "enter" | "space" | "down") {
			self.toggle(window, cx);
			cx.stop_propagation();
		}
	}
}

impl Render for Select {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let open = self.popover.read(cx).is_open();
		let label = self.selected.and_then(|ix| self.labels.get(ix)).cloned();
		let (label, color) = match label {
			Some(label) => (label, palette.text.primary),
			None => (self.placeholder.clone(), palette.text.muted),
		};
		let bounds = Rc::clone(&self.trigger_bounds);
		let trigger = div()
			.id("select-trigger")
			.track_focus(&self.focus)
			.flex()
			.items_center()
			.gap(space::S2)
			.h(size::CONTROL)
			.min_w(size::MENU_MIN_WIDTH)
			.px(space::S2_5)
			.rounded(radius::MD)
			.border_1()
			.border_color(if open {
				palette.border.strong
			} else {
				palette.border.default
			})
			.bg(palette.bg.surface)
			.type_style(text::UI)
			.text_color(color)
			.cursor_pointer()
			.transition(hover_transition())
			.hover(|style| style.border_color(palette.border.strong))
			.on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.toggle(window, cx)))
			.on_key_down(cx.listener(Self::on_key_down))
			.child(div().flex_1().truncate().child(label))
			.child(
				div()
					.flex_none()
					.text_color(palette.text.muted)
					.child("\u{25be}"),
			);
		div()
			.on_children_prepainted(move |children, _, _| {
				if let Some(first) = children.first() {
					bounds.set(*first);
				}
			})
			.child(trigger)
			.child(self.popover.clone())
	}
}
