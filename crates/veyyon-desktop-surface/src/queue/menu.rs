//! The menu a right-click on a queue row opens (§5.1, §8.25).
//!
//! The menu offers the row's answers in one place the pointer is already at:
//! open the session, and the park, defer, unpark, or recall move the row's
//! partition offers.
//! It is window-local, like a hover: the state carries no record of it, so a
//! snapshot from the host never reopens a menu the operator dismissed.

use veyyon_desktop_kit::{AnchorCorner, IconName, Menu, MenuItem, Popover, SpacingStep, TokenSet};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, Styled, div,
};

use crate::{
	Intent, ShellView,
	controls::{Availability, ControlError, ControlStates, error_hairline_weak},
};
/// The partition kind of a queue row menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowMenuKind {
	/// Active card row: park and defer.
	Card,
	/// Pinned card row: unpin, then what a card offers.
	Pinned,
	/// Archival parked line row: unpark.
	Parked,
	/// Archival deferred line row: recall.
	Deferred,
}

/// A row menu that is open: which row, where the pointer was, and what kind of
/// row menu to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowMenu {
	pub id:     u64,
	pub origin: Point<Pixels>,
	pub kind:   RowMenuKind,
}

impl RowMenu {
	/// Returns whether this menu is for a card row.
	#[must_use]
	pub const fn is_card(&self) -> bool {
		matches!(self.kind, RowMenuKind::Card | RowMenuKind::Pinned)
	}
}

/// One management answer a card row's menu offers: the label it draws, the
/// icon beside it, whether it is destructive, the control whose gate decides
/// it, and the intent selecting it sends.
pub struct RowAnswer {
	pub label:   &'static str,
	pub icon:    Option<IconName>,
	pub danger:  bool,
	pub surface: SurfaceId,
	pub intent:  Intent,
}

/// The management answers a card row offers, in the order they are drawn.
///
/// The menu's items, the hairline a refused answer draws under it, and the
/// projection that gates them read this one table, so an answer added here is
/// gated, stated and swept everywhere at once.
#[must_use]
pub fn card_row_answers(id: u64) -> [RowAnswer; 5] {
	let sid = SessionId::from(id.to_string());
	[
		RowAnswer {
			label:   "Branch",
			icon:    None,
			danger:  false,
			surface: SurfaceId::SessionBranchButton(sid.clone()),
			intent:  Intent::BranchSession(id),
		},
		RowAnswer {
			label:   "Export",
			icon:    Some(IconName::File),
			danger:  false,
			surface: SurfaceId::SessionExportButton(sid.clone()),
			intent:  Intent::ExportSession(Some(id)),
		},
		RowAnswer {
			label:   "Compact",
			icon:    Some(IconName::Layers),
			danger:  false,
			surface: SurfaceId::SessionCompactButton(sid.clone()),
			intent:  Intent::CompactSession(Some(id)),
		},
		RowAnswer {
			label:   "Handoff",
			icon:    Some(IconName::ArrowRight),
			danger:  false,
			surface: SurfaceId::SessionHandoffButton(sid.clone()),
			intent:  Intent::HandoffSession(Some(id)),
		},
		RowAnswer {
			label:   "Delete",
			icon:    Some(IconName::Trash),
			danger:  true,
			surface: SurfaceId::QueueDeleteButton(sid),
			intent:  Intent::DeleteSession(id),
		},
	]
}

/// The item an answer draws at the gate its own control resolved (§4.3): a
/// refused answer is not selectable, and one waiting on the host says so.
fn gated_item(answer: &RowAnswer, av: &Availability) -> MenuItem {
	let mut item = MenuItem::new(answer.label);
	if let Some(icon) = answer.icon {
		item = item.icon(icon);
	}
	if answer.danger {
		item = item.danger(true);
	}
	match av {
		Availability::Pending => item.shortcut("In flight...").disabled(true),
		Availability::Unavailable { .. } => item.disabled(true),
		Availability::Enabled | Availability::Unknown => item,
	}
}

/// What the menu's rows dispatch, in the order they are drawn.
///
/// The layer draws these and the suite that pins the gate reads them, so an
/// item's availability is asserted where it is decided rather than out of a
/// raster.
#[must_use]
pub fn row_menu_items(menu: &RowMenu, controls: &ControlStates) -> Vec<(MenuItem, Intent)> {
	match menu.kind {
		RowMenuKind::Card | RowMenuKind::Pinned => {
			let mut items = vec![(MenuItem::new("Open"), Intent::SelectSession(menu.id))];
			if matches!(menu.kind, RowMenuKind::Pinned) {
				items
					.push((MenuItem::new("Unpin").icon(IconName::Unpin), Intent::UnpinSession(menu.id)));
			}
			items.extend([
				(MenuItem::new("Park").icon(IconName::Stop), Intent::ParkSession(menu.id)),
				(MenuItem::new("Defer").icon(IconName::Pause), Intent::DeferSession(menu.id)),
			]);
			items.extend(card_row_answers(menu.id).into_iter().map(|answer| {
				let av = controls.availability(&answer.surface);
				(gated_item(&answer, &av), answer.intent)
			}));
			items
		},
		RowMenuKind::Parked => vec![
			(MenuItem::new("Open"), Intent::SelectSession(menu.id)),
			(MenuItem::new("Unpark").icon(IconName::Play), Intent::UnparkSession(menu.id)),
		],
		RowMenuKind::Deferred => vec![
			(MenuItem::new("Open"), Intent::SelectSession(menu.id)),
			(MenuItem::new("Recall").icon(IconName::Refresh), Intent::RecallSession(menu.id)),
		],
	}
}

/// The layer drawn over the window while a row menu is open: a scrim that
/// takes the dismissing click, and the menu floated at the pointer.
pub fn row_menu_layer(
	menu: RowMenu,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let (items, intents): (Vec<MenuItem>, Vec<Intent>) =
		row_menu_items(&menu, controls).into_iter().unzip();
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

	let mut content = div()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(picker);

	if menu.is_card() {
		let weak = Some(cx.weak_entity());
		for answer in card_row_answers(menu.id) {
			let (label, surface) = (answer.label, answer.surface);
			if let Some(err) = controls.error(&surface) {
				content = content.child(error_hairline_weak(err, surface, tokens, weak.clone()));
			} else if let Some(reason) = controls.availability(&surface).reason() {
				let err = ControlError::new(format!("{label}: {reason}"), false);
				content = content.child(error_hairline_weak(&err, surface, tokens, weak.clone()));
			}
		}
	}

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
		.child(Popover::new(menu.origin, AnchorCorner::TopLeft, content))
}
