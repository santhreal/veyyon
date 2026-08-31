//! Transcript entry list assembly and surface state dispatch.

use gpui::{
	AnyElement, App, Context, Entity, InteractiveElement, IntoElement, ParentElement, Styled, div,
	list, px,
};
use veyyon_gui_core::{
	Store,
	model::{ConnectionState, StaleReason},
};
use veyyon_gui_kit::{
	theme::{Elevation, layout, space},
	ui::scrolls_list,
};

use super::{
	banners,
	logic::{self, SurfaceState},
	timeline::Timeline,
};
use crate::render::entry;

impl Timeline {
	fn render_row(
		&mut self,
		index: usize,
		_window: &mut gpui::Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let Some(value) = self.rows.get(index) else {
			return div().into_any_element();
		};
		let Some(cache) = self.entry_cache.get(&value.id) else {
			return div().into_any_element();
		};
		let streaming = self.streaming_entry.as_ref() == Some(&value.id) && !self.stale_partial;
		let stale = self.streaming_entry.as_ref() == Some(&value.id) && self.stale_partial;
		div()
			.id(format!("entry-{}", value.id))
			.w_full()
			.min_w(px(0.0))
			.max_w(px(layout::reading()))
			.mx_auto()
			.px(px(space::BASE))
			.py(px(space::SNUG))
			.overflow_hidden()
			.child(entry::entry(value, cache, &self.tools, &self.open_tools, streaming, stale, cx))
			.into_any_element()
	}

	fn render_ready(
		&mut self,
		store: &Store,
		stale: Option<&StaleReason>,
		error: Option<(&str, bool)>,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let mut root = div()
			.relative()
			.flex()
			.flex_col()
			.size_full()
			.min_h(px(0.0))
			.overflow_hidden();
		if let Some(paging) = store.replica.transcript_paging.readable()
			&& paging.value.has_earlier
			&& let Some(session) = store.frontend.selected_session.clone()
		{
			let before = paging.value.before.clone();
			root = root.child(banners::earlier_entries_banner(session, before, &paging.value.load));
		}
		if let Some(reason) = stale {
			root = root.child(banners::stale_banner(reason));
		}
		if let Some((message, _)) = error {
			root = root.child(banners::refresh_error_banner(message));
		}
		root = root.child(div().flex_1().min_h(px(0.0)).w_full().child(scrolls_list(
			list(self.list.clone(), cx.processor(Self::render_row)).size_full(),
			&self.list,
			Elevation::Canvas,
		)));
		if self.follow.show_jump() {
			root = root.child(banners::jump_button(self.follow.unseen));
		}
		root.into_any_element()
	}

	fn render_surface(&mut self, store: &Store, cx: &mut Context<Self>) -> AnyElement {
		self.sync(store);
		// Before the session check: with no host there is no session to select,
		// and "Select a session" over an empty list is an instruction a reader
		// cannot follow.
		if matches!(store.connection, ConnectionState::Detached) {
			return banners::detached();
		}
		if store.frontend.selected_session.is_none() {
			return banners::no_session();
		}
		match logic::surface(&store.connection, &store.replica.transcript) {
			SurfaceState::Loading { received, expected } => banners::loading(received, expected),
			SurfaceState::Empty if !self.rows.is_empty() => self.render_ready(store, None, None, cx),
			SurfaceState::Empty => banners::empty_transcript(),
			SurfaceState::Unavailable { message, retryable } => {
				banners::unavailable(message, retryable, store.frontend.selected_session.clone())
			},
			SurfaceState::Fatal { message } => banners::fatal(message),
			SurfaceState::Ready { value, stale, error } if value.is_empty() => {
				banners::empty_conversation(stale.is_some(), error.is_some())
			},
			SurfaceState::Ready { stale, error, .. } => self.render_ready(store, stale, error, cx),
		}
	}
}

pub fn render(store: &Store, timeline: &Entity<Timeline>, cx: &mut App) -> AnyElement {
	timeline.update(cx, |timeline, cx| timeline.render_surface(store, cx))
}
