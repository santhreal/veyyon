//! Thread search: the local title filter, applied on each keystroke, and the
//! host's full-text search, sent once typing pauses and drawn under the
//! local matches.

use std::{collections::HashSet, time::Duration};

use gpui::{AnyElement, Context, Window, div, prelude::*};
use veyyon_desktop_model::{HostAction, SessionId, SurfaceId};
use veyyon_desktop_ui::{
	controls::ListRow,
	editor::EditorEvent,
	theme::{ActiveTheme, TypeStyled, space, text},
};

use super::Sidebar;

/// How long typing pauses before the host is asked to search.
const SEARCH_PAUSE: Duration = Duration::from_millis(250);

/// The most host matches drawn.
const HOST_HITS: usize = 20;

impl Sidebar {
	pub(super) fn on_search_event(
		&mut self,
		event: EditorEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match event {
			EditorEvent::Changed => {
				let query = self.search.read(cx).text().trim().to_owned();
				self.set_query(query, cx);
			},
			EditorEvent::Escape => {
				self.search.update(cx, |editor, cx| editor.set_text("", cx));
				window.focus(&self.focus, cx);
			},
			EditorEvent::Submit => {
				let first = (0..self.items.len()).find_map(|ix| self.session_at(ix, cx));
				if let Some(session) = first {
					self.open(session, cx);
				}
			},
			_ => {},
		}
	}

	/// Filters the list by `query` and schedules the host search for it.
	fn set_query(&mut self, query: String, cx: &mut Context<Self>) {
		if query == self.query {
			return;
		}
		self.folded = query.to_lowercase();
		self.query = query;
		self.rebuild_items(cx);
		self.host_search = None;
		if !self.query.is_empty() {
			let sent = self.query.clone();
			self.host_search = Some(cx.spawn(async move |this, cx| {
				cx.background_executor().timer(SEARCH_PAUSE).await;
				let _ = this.update(cx, |this, cx| {
					let action = HostAction::SearchSessions { query: sent };
					this.app
						.update(cx, |app, cx| app.dispatch(action, SurfaceId::QueueFilterInput, cx));
				});
			}));
		}
		cx.notify();
	}

	/// The host's full-text matches for the current query that the local
	/// filter did not list.
	pub(super) fn render_search_hits(&self, cx: &Context<Self>) -> Option<AnyElement> {
		if self.query.is_empty() {
			return None;
		}
		let view = self.app.read(cx).store().domains.session_search.as_ref()?;
		if view.query != self.query {
			return None;
		}
		let listed: HashSet<SessionId> =
			(0..self.items.len()).filter_map(|ix| self.session_at(ix, cx)).collect();
		let palette = cx.theme().palette;
		let rows: Vec<AnyElement> = view
			.sessions
			.iter()
			.filter(|hit| !listed.contains(&hit.id))
			.take(HOST_HITS)
			.enumerate()
			.map(|(ix, hit)| {
				let session = hit.id.clone();
				let title = hit
					.title
					.clone()
					.or_else(|| hit.first_message.clone())
					.unwrap_or_else(|| "new session".to_owned());
				ListRow::new(("sidebar-hit", ix), title)
					.on_click(cx.listener(move |this, _, _, cx| this.open(session.clone(), cx)))
					.into_any_element()
			})
			.collect();
		if rows.is_empty() {
			return None;
		}
		Some(
			div()
				.flex()
				.flex_col()
				.px(space::S2)
				.pb(space::S2)
				.child(
					div()
						.px(space::S2)
						.py(space::S1)
						.type_style(text::SMALL)
						.text_color(palette.text.muted)
						.child("In messages"),
				)
				.children(rows)
				.into_any_element(),
		)
	}
}
