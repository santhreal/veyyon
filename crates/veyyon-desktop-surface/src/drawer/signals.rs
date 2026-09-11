//! The signals a supervised process's row offers (§5.12, §8.25).
//!
//! The drawer could stop a process and restart it, which is one signal of the
//! five the supervisor accepts, chosen for the operator and spelled beside the
//! action. A process that ignores `SIGTERM` -- a shell holding a trap, a
//! watcher that swallowed it -- is exactly the case the other four exist for,
//! and the window offered none of them.
//!
//! So the row's signal press opens a menu over the pointer with one row per
//! variant of [`SupervisorSignal`]. The set is swept from the enum, so a signal
//! the supervisor learns is offered here as soon as it is typed, and the one
//! nothing can catch is drawn as destructive because it takes the process's
//! chance to exit on its own terms.

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{AnchorCorner, IconName, Menu, MenuItem, Popover};
use veyyon_desktop_model::SupervisorSignal;
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, Styled, div,
};

use crate::{Intent, ShellView};

/// The signal menu that is open: which process, and where the press landed.
///
/// Window-local, like the queue's row menu and the transcript's turn menu: the
/// state carries no record of it, so a snapshot from the host never reopens a
/// menu the operator dismissed. The name is taken when the menu opens, so the
/// signal reaches the process whose row was pressed even if the supervisor's
/// list reorders while the menu is up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalMenu {
	pub process: String,
	pub origin:  Point<Pixels>,
}

/// The rows a signal menu offers, in the order the enum declares them.
///
/// The label leads and the wire spelling follows it, because the supervisor's
/// logs and anything else the operator reads name the signal by that spelling.
#[must_use]
pub fn signal_menu_items(menu: &SignalMenu) -> Vec<(MenuItem, Intent)> {
	SupervisorSignal::iter()
		.map(|signal| {
			let item = MenuItem::new(format!("{} ({})", signal.label(), signal.wire()))
				.icon(IconName::Zap)
				.danger(signal.uncatchable());
			(item, Intent::ProcessSignal { process: menu.process.clone(), signal })
		})
		.collect()
}

/// The layer drawn over the window while a signal menu is open: a scrim that
/// takes the dismissing click, and the menu floated at the press.
pub fn signal_menu_layer(menu: &SignalMenu, cx: &Context<ShellView>) -> impl IntoElement {
	let (items, intents): (Vec<MenuItem>, Vec<Intent>) = signal_menu_items(menu).into_iter().unzip();
	let entity = cx.entity();
	let rows = Menu::new(items).on_select(move |index, _event, _window, app| {
		let intent = intents.get(index).cloned();
		let () = entity.update(app, |view, cx| {
			view.close_signal_menu();
			if let Some(intent) = intent {
				view.dispatch(intent, cx);
			}
			cx.notify();
		});
	});

	div()
		.id("process-signal-menu-scrim")
		.absolute()
		.inset_0()
		.on_mouse_down(
			MouseButton::Left,
			cx.listener(|view, _event, _window, cx| {
				view.close_signal_menu();
				cx.notify();
			}),
		)
		.on_mouse_down(
			MouseButton::Right,
			cx.listener(|view, _event, _window, cx| {
				view.close_signal_menu();
				cx.notify();
			}),
		)
		.child(Popover::new(menu.origin, AnchorCorner::TopLeft, rows))
}
