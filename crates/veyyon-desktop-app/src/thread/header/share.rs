//! The menu the header's sharing chip opens: each link a hosted share
//! offers, copied to the clipboard when picked, and the room a joined share
//! is in.

use gpui::{ClipboardItem, Context, Entity, IntoElement, Pixels, Point, SharedString, Window};
use veyyon_desktop_model::domain::{ShareRole, ShareView};
use veyyon_desktop_ui::{
	icons::{Icon, IconName},
	overlays::{ContextMenu, MenuEvent, MenuItem, MenuRow},
	theme::size,
};

use super::ThreadHeader;

/// The chip the header draws for `role`, or `None` while nothing is shared.
pub(super) const fn chip(role: ShareRole) -> Option<&'static str> {
	match role {
		ShareRole::Hosting => Some("Sharing"),
		ShareRole::Guest => Some("Joined"),
		ShareRole::Off => None,
	}
}

impl ThreadHeader {
	/// Opens the share menu at `position`, listing the share as the host
	/// states it now.
	pub(super) fn open_share_menu(
		&mut self,
		position: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.list_share(cx);
		self
			.share_menu
			.update(cx, |menu, cx| menu.open_at(position, window, cx));
	}

	/// Lists the share the host states again in an open share menu. A
	/// closed one is listed when it opens.
	pub(super) fn restate_share_menu(&mut self, cx: &mut Context<Self>) {
		if self.share_menu.read(cx).is_open(cx) {
			self.list_share(cx);
		}
	}

	/// Copies the link of the row picked.
	pub(super) fn on_share_pick(
		&mut self,
		_: &Entity<ContextMenu>,
		event: &MenuEvent,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let MenuEvent::Picked(ix) = event else {
			return;
		};
		if let Some(Some(link)) = self.share_picks.get(*ix) {
			cx.write_to_clipboard(ClipboardItem::new_string(link.clone()));
		}
	}

	fn list_share(&mut self, cx: &mut Context<Self>) {
		let (items, picks) = self
			.app
			.read(cx)
			.store()
			.domains
			.share
			.as_ref()
			.map(menu)
			.unwrap_or_default();
		self.share_picks = picks;
		self
			.share_menu
			.update(cx, |menu, cx| menu.set_items(items, cx));
	}
}

/// The links a hosted share offers, under the name the menu lists each by,
/// in the order it lists them.
const fn links(share: &ShareView) -> [(&'static str, Option<&String>); 4] {
	[
		("Veyyon link", share.link.as_ref()),
		("Browser link", share.web_link.as_ref()),
		("Read-only veyyon link", share.view_link.as_ref()),
		("Read-only browser link", share.web_view_link.as_ref()),
	]
}

/// How many guests a hosted share has: every party but the host.
fn guests(share: &ShareView) -> SharedString {
	match share
		.participants
		.iter()
		.filter(|party| !party.is_host)
		.count()
	{
		0 => "No guests".into(),
		1 => "1 guest".into(),
		count => format!("{count} guests").into(),
	}
}

/// The rows the share menu lists for `share`, and the link picking each
/// one copies. A hosted share lists its guests and then each link it
/// offers under its name; a joined one lists the room it is in.
fn menu(share: &ShareView) -> (Vec<MenuItem>, Vec<Option<String>>) {
	let mut items = Vec::new();
	let mut picks = Vec::new();
	match share.role {
		ShareRole::Hosting => {
			items.push(MenuItem::header(guests(share)));
			picks.push(None);
			for (name, link) in links(share) {
				let Some(link) = link else {
					continue;
				};
				items.push(MenuItem::header(name));
				picks.push(None);
				let row = MenuRow::new(link.clone()).leading(|_, _| {
					Icon::new(IconName::Copy)
						.size(size::ICON_SM)
						.into_any_element()
				});
				items.push(row.into());
				picks.push(Some(link.clone()));
			}
		},
		ShareRole::Guest => {
			let host = share
				.guest
				.as_ref()
				.and_then(|guest| guest.host_name.as_deref());
			items.push(MenuItem::header(
				host.map_or_else(|| "Joined".to_owned(), |host| format!("Joined {host}")),
			));
			picks.push(None);
			if let Some(guest) = &share.guest {
				let row = MenuRow::new(guest.room.clone()).disabled(true);
				items.push(
					if guest.read_only {
						row.hint("read-only")
					} else {
						row
					}
					.into(),
				);
				picks.push(None);
			}
		},
		ShareRole::Off => {},
	}
	(items, picks)
}
