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

/// What the menu's rows dispatch, in the order they are drawn.
fn choices(menu: &RowMenu, controls: &ControlStates) -> Vec<(MenuItem, Intent)> {
	match menu.kind {
		RowMenuKind::Card | RowMenuKind::Pinned => {
			let sid = SessionId::from(menu.id.to_string());
			let branch_surface = SurfaceId::SessionBranchButton(sid.clone());
			let branch_av = controls.availability(&branch_surface);
			let mut branch_item = MenuItem::new("Branch");
			if matches!(branch_av, Availability::Pending) {
				branch_item = branch_item.shortcut("In flight...").disabled(true);
			} else if matches!(branch_av, Availability::Unavailable { .. }) {
				branch_item = branch_item.disabled(true);
			}

			let export_surface = SurfaceId::SessionExportButton(sid.clone());
			let export_av = controls.availability(&export_surface);
			let mut export_item = MenuItem::new("Export").icon(IconName::File);
			if matches!(export_av, Availability::Pending) {
				export_item = export_item.shortcut("In flight...").disabled(true);
			} else if matches!(export_av, Availability::Unavailable { .. }) {
				export_item = export_item.disabled(true);
			}

			let compact_surface = SurfaceId::SessionCompactButton(sid.clone());
			let compact_av = controls.availability(&compact_surface);
			let mut compact_item = MenuItem::new("Compact").icon(IconName::Layers);
			if matches!(compact_av, Availability::Pending) {
				compact_item = compact_item.shortcut("In flight...").disabled(true);
			} else if matches!(compact_av, Availability::Unavailable { .. }) {
				compact_item = compact_item.disabled(true);
			}

			let handoff_surface = SurfaceId::SessionHandoffButton(sid.clone());
			let handoff_av = controls.availability(&handoff_surface);
			let mut handoff_item = MenuItem::new("Handoff").icon(IconName::ArrowRight);
			if matches!(handoff_av, Availability::Pending) {
				handoff_item = handoff_item.shortcut("In flight...").disabled(true);
			} else if matches!(handoff_av, Availability::Unavailable { .. }) {
				handoff_item = handoff_item.disabled(true);
			}

			let delete_surface = SurfaceId::QueueDeleteButton(sid);
			let delete_av = controls.availability(&delete_surface);
			let mut delete_item = MenuItem::new("Delete").icon(IconName::Trash).danger(true);
			if matches!(delete_av, Availability::Pending) {
				delete_item = delete_item.shortcut("In flight...").disabled(true);
			} else if matches!(delete_av, Availability::Unavailable { .. }) {
				delete_item = delete_item.disabled(true);
			}

			let mut items = vec![(MenuItem::new("Open"), Intent::SelectSession(menu.id))];
			if matches!(menu.kind, RowMenuKind::Pinned) {
				items
					.push((MenuItem::new("Unpin").icon(IconName::Unpin), Intent::UnpinSession(menu.id)));
			}
			items.extend([
				(MenuItem::new("Park").icon(IconName::Stop), Intent::ParkSession(menu.id)),
				(MenuItem::new("Defer").icon(IconName::Pause), Intent::DeferSession(menu.id)),
				(branch_item, Intent::BranchSession(menu.id)),
				(export_item, Intent::ExportSession(Some(menu.id))),
				(compact_item, Intent::CompactSession(Some(menu.id))),
				(handoff_item, Intent::HandoffSession(Some(menu.id))),
				(delete_item, Intent::DeleteSession(menu.id)),
			]);
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
		choices(&menu, controls).into_iter().unzip();
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
		let sid = SessionId::from(menu.id.to_string());
		let branch_surface = SurfaceId::SessionBranchButton(sid.clone());
		let export_surface = SurfaceId::SessionExportButton(sid.clone());
		let compact_surface = SurfaceId::SessionCompactButton(sid.clone());
		let handoff_surface = SurfaceId::SessionHandoffButton(sid.clone());
		let delete_surface = SurfaceId::QueueDeleteButton(sid);
		let weak = Some(cx.weak_entity());

		for (surface, label) in [
			(branch_surface, "Branch"),
			(export_surface, "Export"),
			(compact_surface, "Compact"),
			(handoff_surface, "Handoff"),
			(delete_surface, "Delete"),
		] {
			if let Some(err) = controls.error(&surface) {
				content = content.child(error_hairline_weak(err, surface, tokens, weak.clone()));
			} else {
				let av = controls.availability(&surface);
				if let Some(reason) = av.reason() {
					let err = ControlError::new(format!("{label}: {reason}"), false);
					content = content.child(error_hairline_weak(&err, surface, tokens, weak.clone()));
				}
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
