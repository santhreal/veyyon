//! The menu a right-click on a queue row opens (§5.1, §8.25).
//!
//! The menu offers the row's answers in one place the pointer is already at:
//! open the session, and the park or defer move the row's hover slot offers.
//! It is window-local, like a hover: the state carries no record of it, so a
//! snapshot from the host never reopens a menu the operator dismissed.

use veyyon_desktop_kit::{AnchorCorner, IconName, Menu, MenuItem, Popover};
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, Styled, div,
};

use crate::{Intent, ShellView};

/// A row menu that is open: which row, where the pointer was, and whether
/// the row is a card (park and defer) or a line (unpark and recall).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowMenu {
	pub id:     u64,
	pub origin: Point<Pixels>,
	pub card:   bool,
}

/// What the menu's rows dispatch, in the order they are drawn.
fn choices(menu: &RowMenu) -> [(MenuItem, Intent); 3] {
	let (park, defer) = if menu.card {
		(("Park", IconName::Stop), ("Defer", IconName::Pause))
	} else {
		(("Unpark", IconName::Play), ("Recall", IconName::Refresh))
	};
	[
		(MenuItem::new("Open"), Intent::SelectSession(menu.id)),
		(MenuItem::new(park.0).icon(park.1), Intent::ParkSession(menu.id)),
		(MenuItem::new(defer.0).icon(defer.1), Intent::DeferSession(menu.id)),
	]
}

/// The layer drawn over the window while a row menu is open: a scrim that
/// takes the dismissing click, and the menu floated at the pointer.
pub fn row_menu_layer(menu: RowMenu, cx: &Context<ShellView>) -> impl IntoElement {
	let (items, intents): (Vec<MenuItem>, Vec<Intent>) = choices(&menu).into_iter().unzip();
	let entity = cx.entity();
	let picker = Menu::new(items).on_select(move |index, _event, _window, app| {
		let intent = intents.get(index).cloned();
		let () = entity.update(app, |view, cx| {
			view.close_row_menu();
			if let Some(intent) = intent {
				view.dispatch(intent, cx);
			}
			cx.notify();
		});
	});

	div()
		.id("queue-row-menu-scrim")
		.absolute()
		.inset_0()
		.on_mouse_down(
			MouseButton::Left,
			cx.listener(|view, _event, _window, cx| {
				view.close_row_menu();
				cx.notify();
			}),
		)
		.on_mouse_down(
			MouseButton::Right,
			cx.listener(|view, _event, _window, cx| {
				view.close_row_menu();
				cx.notify();
			}),
		)
		.child(Popover::new(menu.origin, AnchorCorner::TopLeft, picker))
}
