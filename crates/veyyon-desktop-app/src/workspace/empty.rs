//! What the window draws in place of the thread while no session is open:
//! a welcome line, the new-thread action and the most recent threads.

use gpui::{Context, Entity, Render, Subscription, Window, div, prelude::*};
use veyyon_desktop_ui::{
	controls::{Button, ButtonVariant},
	theme::{ActiveTheme, TypeStyled, space, text},
};

use crate::{AppState, StoreEvent, actions::workspace as act};

/// How many recent threads the empty state lists.
const RECENT_THREADS: usize = 5;

/// The empty state.
pub(super) struct EmptyState {
	app:           Entity<AppState>,
	_subscription: Subscription,
}

impl EmptyState {
	/// An empty state that redraws when the session listing of `app` changes.
	pub(super) fn new(app: Entity<AppState>, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |_, _, event: &StoreEvent, cx| {
			if matches!(event, StoreEvent::SessionsChanged) {
				cx.notify();
			}
		});
		Self { app, _subscription: subscription }
	}
}

impl Render for EmptyState {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let mut recent: Vec<_> = self
			.app
			.read(cx)
			.projects()
			.iter()
			.flat_map(|project| &project.sessions)
			.filter(|row| row.depth == 0)
			.map(|row| (row.id.clone(), row.title.clone(), row.modified_at_ms))
			.collect();
		recent.sort_by_key(|row| std::cmp::Reverse(row.2));
		recent.truncate(RECENT_THREADS);
		let rows = recent.into_iter().enumerate().map(|(ix, (id, title, _))| {
			let app = self.app.clone();
			div()
				.debug_selector(move || format!("empty-recent-thread-{ix}"))
				.child(
					Button::new(("empty-recent-thread", ix), title)
						.variant(ButtonVariant::Ghost)
						.on_click(move |_, _, cx| {
							app.update(cx, |app, cx| {
								app.open_session(id.clone(), cx);
							});
						}),
				)
		});
		div()
			.size_full()
			.flex()
			.flex_col()
			.items_center()
			.justify_center()
			.gap(space::S3)
			.bg(palette.bg.app)
			.child(
				div()
					.type_style(text::TITLE)
					.text_color(palette.text.primary)
					.child("No thread is open."),
			)
			.child(
				div()
					.debug_selector(|| "empty-new-thread".to_owned())
					.child(
						Button::new("empty-new-thread", "New thread")
							.variant(ButtonVariant::Primary)
							.on_click(|_, window, cx| {
								window.dispatch_action(Box::new(act::NewThread), cx);
							}),
					),
			)
			.children(rows)
	}
}
