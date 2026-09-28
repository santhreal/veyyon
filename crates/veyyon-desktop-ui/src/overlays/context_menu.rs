//! A [`Menu`] opened at the pointer, as on a right click.

use veyyon_gpui::{
	Anchor, App, Context, Entity, EventEmitter, IntoElement, Pixels, Point, Render, Subscription,
	Window, prelude::*,
};

use super::{Menu, MenuEvent, MenuItem, Popover};

/// A menu in a popover whose top-left corner opens at a window point.
///
/// Re-emits the menu's [`MenuEvent`]s and closes on a pick, on Escape and on
/// a click outside. Render the entity anywhere in the owner's tree and call
/// [`ContextMenu::open_at`] from the owner's right-click handler with the
/// event position.
pub struct ContextMenu {
	menu:          Entity<Menu>,
	popover:       Entity<Popover>,
	_subscription: Subscription,
}

impl EventEmitter<MenuEvent> for ContextMenu {}

impl ContextMenu {
	/// A closed context menu of `items`.
	pub fn new(items: Vec<MenuItem>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let menu = cx.new(|cx| Menu::new(items, cx));
		let popover = cx.new(|cx| Popover::new(&menu, cx));
		let subscription = cx.subscribe_in(&menu, window, Self::on_menu_event);
		Self { menu, popover, _subscription: subscription }
	}

	/// The menu the context menu shows.
	pub const fn menu(&self) -> &Entity<Menu> {
		&self.menu
	}

	/// Replaces the items.
	pub fn set_items(&mut self, items: Vec<MenuItem>, cx: &mut Context<Self>) {
		self.menu.update(cx, |menu, cx| menu.set_items(items, cx));
	}

	/// Opens the menu with its top-left corner at `position`, in window
	/// coordinates, with nothing highlighted.
	pub fn open_at(&mut self, position: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
		self.menu.update(cx, |menu, cx| menu.highlight(None, cx));
		self.popover.update(cx, |popover, cx| {
			popover.open(position, Anchor::TopLeft, None, window, cx);
		});
	}

	/// Whether the menu is open.
	pub fn is_open(&self, cx: &App) -> bool {
		self.popover.read(cx).is_open()
	}

	fn on_menu_event(
		&mut self,
		_: &Entity<Menu>,
		event: &MenuEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.popover.update(cx, |popover, cx| popover.close(window, cx));
		cx.emit(*event);
	}
}

impl Render for ContextMenu {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		self.popover.clone()
	}
}
