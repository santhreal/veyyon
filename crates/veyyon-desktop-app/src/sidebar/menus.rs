//! The thread row menu and the profile switcher menu, and what each pick
//! sends.

use gpui::{Context, Entity, Pixels, Point, Window};
use veyyon_desktop_model::{
	Gate, HostAction, HostActionKind, QueuePartition, SessionId, SurfaceId,
};
use veyyon_desktop_ui::overlays::{ContextMenu, MenuEvent, MenuItem, MenuRow};

use super::{Sidebar, naming::NameTarget};
use crate::AppState;

/// What a row of the thread menu does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RowPick {
	Open,
	Rename,
	/// Toggles the thread in or out of a partition.
	Place(QueuePartition),
	Branch,
	Peek,
	Export,
	Compact,
	Handoff,
	Delete,
}

/// One item of the thread menu and what picking it does.
type MenuLine = (MenuItem, Option<RowPick>);

/// The thread menu for `session`, and the pick of each of its items. A
/// placement toggle names the move out when the thread is already placed
/// there, and a verb the host cannot take now is disabled.
pub(super) fn row_menu(
	app: &AppState,
	session: &SessionId,
) -> (Vec<MenuItem>, Vec<Option<RowPick>>) {
	let placed = app.partition(session);
	let toggle = |into: QueuePartition, add: &str, remove: &str, key: &str| -> MenuLine {
		let label = if placed == into { remove } else { add };
		(MenuRow::new(label.to_owned()).hint(key.to_owned()).into(), Some(RowPick::Place(into)))
	};
	let gated = |label: &str, key: Option<&str>, kind: HostActionKind, pick: RowPick| -> MenuLine {
		let row = MenuRow::new(label.to_owned());
		let row = match (app.gate(kind), key) {
			(Gate::Enabled | Gate::Unknown, Some(key)) => row.hint(key.to_owned()),
			(Gate::Enabled | Gate::Unknown, None) => row,
			(Gate::Pending { .. }, _) => row.hint("In flight").disabled(true),
			(Gate::Unavailable { .. }, _) => row.disabled(true),
		};
		(row.into(), Some(pick))
	};
	let rows: [MenuLine; 14] = [
		(MenuRow::new("Open").hint("Enter").into(), Some(RowPick::Open)),
		gated("Rename", Some("F2"), HostActionKind::RenameSession, RowPick::Rename),
		(MenuItem::Separator, None),
		toggle(QueuePartition::Pinned, "Pin", "Unpin", "P"),
		toggle(QueuePartition::Deferred, "Defer", "Recall", "D"),
		toggle(QueuePartition::Parked, "Archive", "Restore", "K"),
		(MenuItem::Separator, None),
		gated("Branch", None, HostActionKind::BranchSession, RowPick::Branch),
		gated("Peek", None, HostActionKind::PreviewSessionTranscript, RowPick::Peek),
		gated("Export as HTML", None, HostActionKind::ExportSession, RowPick::Export),
		gated("Compact", None, HostActionKind::CompactSession, RowPick::Compact),
		gated("Handoff", None, HostActionKind::HandoffSession, RowPick::Handoff),
		(MenuItem::Separator, None),
		gated("Delete", Some("Del"), HostActionKind::DeleteSession, RowPick::Delete),
	];
	rows.into_iter().unzip()
}

/// What a row of the profile menu does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ProfilePick {
	/// A header, a separator or a profile listed for information.
	Nothing,
	New,
	Rename(String),
	Delete(String),
	Refresh,
}

impl Sidebar {
	/// Rebuilds the profile menu from the host's profile listing.
	pub(super) fn rebuild_profile_menu(&mut self, cx: &mut Context<Self>) {
		let mut items = vec![MenuItem::header("Profiles")];
		let mut picks = vec![ProfilePick::Nothing];
		let profiles = self
			.app
			.read(cx)
			.store()
			.domains
			.profiles
			.clone()
			.unwrap_or_default();
		for entry in &profiles.entries {
			let hint = if entry.is_active {
				Some("active".to_owned())
			} else {
				entry.endpoint_error.clone()
			};
			let row = MenuRow::new(entry.label()).disabled(!entry.is_active);
			items.push(match hint {
				Some(hint) => row.hint(hint).into(),
				None => row.into(),
			});
			picks.push(ProfilePick::Nothing);
		}
		items.push(MenuItem::Separator);
		picks.push(ProfilePick::Nothing);
		items.push(MenuRow::new("New profile").into());
		picks.push(ProfilePick::New);
		if let Some(active) = profiles.active_entry() {
			items.push(MenuRow::new(format!("Rename {}", active.label())).into());
			picks.push(ProfilePick::Rename(active.name.clone()));
		}
		for entry in profiles.entries.iter().filter(|entry| !entry.is_active) {
			items.push(MenuRow::new(format!("Delete {}", entry.label())).into());
			picks.push(ProfilePick::Delete(entry.name.clone()));
		}
		items.push(MenuRow::new("Refresh profiles").into());
		picks.push(ProfilePick::Refresh);
		self.profile_picks = picks;
		self
			.profile_menu
			.update(cx, |menu, cx| menu.set_items(items, cx));
	}

	/// Opens the profile menu at `position`.
	pub(super) fn open_profile_menu(
		&self,
		position: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self
			.profile_menu
			.update(cx, |menu, cx| menu.open_at(position, window, cx));
	}

	pub(super) fn on_row_menu_event(
		&mut self,
		_: &Entity<ContextMenu>,
		event: &MenuEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let (MenuEvent::Picked(ix), Some(session)) = (event, self.menu_session.take()) else {
			return;
		};
		let Some(Some(pick)) = self.row_picks.get(*ix).copied() else {
			return;
		};
		let sent = match pick {
			RowPick::Open => {
				self.open(session, cx);
				None
			},
			RowPick::Rename => {
				self.rename(session, window, cx);
				None
			},
			RowPick::Place(into) => {
				self.toggle_placement(&session, into, cx);
				None
			},
			RowPick::Delete => {
				self.selected = Some(session.clone());
				self.confirm_delete = Some(session);
				cx.notify();
				None
			},
			RowPick::Branch => Some((
				HostAction::BranchSession { session: session.clone(), entry: None },
				SurfaceId::SessionBranchButton(session),
			)),
			RowPick::Export => Some((
				HostAction::ExportSession { session: session.clone(), format: "html".to_owned() },
				SurfaceId::SessionExportButton(session),
			)),
			RowPick::Compact => Some((
				HostAction::CompactSession { session: session.clone() },
				SurfaceId::SessionCompactButton(session),
			)),
			RowPick::Handoff => Some((
				HostAction::HandoffSession { session: session.clone(), target: String::new() },
				SurfaceId::SessionHandoffButton(session),
			)),
			RowPick::Peek => {
				self.peek = Some(session.clone());
				cx.notify();
				Some((
					HostAction::PreviewSessionTranscript { session: session.clone() },
					SurfaceId::QueueSessionRow(session),
				))
			},
		};
		if let Some((action, surface)) = sent {
			self
				.app
				.update(cx, |app, cx| app.dispatch(action, surface, cx));
		}
	}

	pub(super) fn on_profile_menu_event(
		&mut self,
		_: &Entity<ContextMenu>,
		event: &MenuEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let MenuEvent::Picked(ix) = event else {
			return;
		};
		let (action, surface) = match self.profile_picks.get(*ix).cloned() {
			Some(ProfilePick::New) => {
				self.start_naming(NameTarget::NewProfile, "", window, cx);
				return;
			},
			Some(ProfilePick::Rename(name)) => {
				let current = self
					.app
					.read(cx)
					.store()
					.domains
					.profiles
					.as_ref()
					.and_then(|profiles| profiles.entry(&name))
					.map(|entry| entry.display_name.clone())
					.unwrap_or_default();
				self.start_naming(NameTarget::Profile(name), &current, window, cx);
				return;
			},
			Some(ProfilePick::Delete(name)) => {
				(HostAction::DeleteProfile { name: name.clone() }, SurfaceId::ProfileDeleteButton(name))
			},
			Some(ProfilePick::Refresh) => {
				(HostAction::RefreshProfiles, SurfaceId::ProfileRefreshButton)
			},
			Some(ProfilePick::Nothing) | None => return,
		};
		self
			.app
			.update(cx, |app, cx| app.dispatch(action, surface, cx));
	}
}
