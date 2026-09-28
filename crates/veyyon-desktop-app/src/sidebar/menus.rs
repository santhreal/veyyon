//! The thread row menu and the profile switcher menu, and what each pick
//! sends.

use gpui::{Context, Entity, Point, Pixels, Window};
use veyyon_desktop_model::{HostAction, SurfaceId};
use veyyon_desktop_ui::overlays::{ContextMenu, MenuEvent, MenuItem, MenuRow};

use super::{Sidebar, naming::NameTarget};

/// What a row of the thread menu does, in menu order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowPick {
	Open,
	Rename,
	Branch,
	Peek,
	Export,
	Compact,
	Delete,
}

/// The thread menu rows, with the separator before Delete at its item index.
const ROW_PICKS: [Option<RowPick>; 8] = [
	Some(RowPick::Open),
	Some(RowPick::Rename),
	Some(RowPick::Branch),
	Some(RowPick::Peek),
	Some(RowPick::Export),
	Some(RowPick::Compact),
	None,
	Some(RowPick::Delete),
];

/// The thread menu.
pub(super) fn row_items() -> Vec<MenuItem> {
	ROW_PICKS
		.iter()
		.map(|pick| match pick {
			Some(RowPick::Open) => MenuRow::new("Open").hint("Enter").into(),
			Some(RowPick::Rename) => MenuRow::new("Rename").hint("F2").into(),
			Some(RowPick::Branch) => MenuRow::new("Branch").into(),
			Some(RowPick::Peek) => MenuRow::new("Peek").into(),
			Some(RowPick::Export) => MenuRow::new("Export as HTML").into(),
			Some(RowPick::Compact) => MenuRow::new("Compact").into(),
			Some(RowPick::Delete) => MenuRow::new("Delete").hint("Del").into(),
			None => MenuItem::Separator,
		})
		.collect()
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
		let profiles = self.app.read(cx).store().domains.profiles.clone().unwrap_or_default();
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
		self.profile_menu.update(cx, |menu, cx| menu.set_items(items, cx));
	}

	/// Opens the profile menu at `position`.
	pub(super) fn open_profile_menu(
		&self,
		position: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.profile_menu
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
		let Some(Some(pick)) = ROW_PICKS.get(*ix) else {
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
			self.app.update(cx, |app, cx| app.dispatch(action, surface, cx));
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
			Some(ProfilePick::Refresh) => (HostAction::RefreshProfiles, SurfaceId::ProfileRefreshButton),
			Some(ProfilePick::Nothing) | None => return,
		};
		self.app.update(cx, |app, cx| app.dispatch(action, surface, cx));
	}
}
