//! The thread column: header and transcript, then the composer lane's dock
//! and composer.
//!
//! `ThreadView` is a cheap shell. Its children are entities of their own,
//! embedded cached. The streaming reply is the transcript list's last item,
//! so a reply taller than the thread scrolls with the list; a streamed delta
//! notifies the tail, which dirties the transcript and this shell, and the
//! header reuses its last frame.

pub mod header;

use gpui::{Context, Entity, Render, StyleRefinement, Subscription, Window, div, prelude::*};
use veyyon_desktop_model::{HostAction, SurfaceId};
use veyyon_desktop_ui::{
	controls::Button,
	theme::{ActiveTheme, TypeStyled, size, space, text},
};

use self::header::ThreadHeader;
use crate::{AppState, StoreEvent, transcript::Transcript};

/// The thread region.
pub struct ThreadView {
	app:           Entity<AppState>,
	header:        Entity<ThreadHeader>,
	transcript:    Entity<Transcript>,
	/// Whether the host has frozen every agent, drawn as the paused strip.
	paused:        bool,
	_subscription: Subscription,
}

impl ThreadView {
	/// Creates the thread column over `app`.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let header = cx.new(|cx| ThreadHeader::new(app.clone(), window, cx));
		let transcript = cx.new(|cx| Transcript::new(app.clone(), window, cx));
		let subscription = cx.subscribe(&app, |this, app, event: &StoreEvent, cx| {
			if matches!(event, StoreEvent::DomainChanged(_) | StoreEvent::ConnectionChanged) {
				let paused = app.read(cx).store().paused.paused;
				if paused != this.paused {
					this.paused = paused;
					cx.notify();
				}
			}
		});
		let paused = app.read(cx).store().paused.paused;
		Self { app, header, transcript, paused, _subscription: subscription }
	}

	/// The transcript entity.
	#[must_use]
	pub const fn transcript(&self) -> &Entity<Transcript> {
		&self.transcript
	}
}

impl Render for ThreadView {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		div()
			.size_full()
			.flex()
			.flex_col()
			.bg(palette.bg.app)
			.child(
				div().w_full().flex_shrink_0().child(
					self
						.header
						.clone()
						.cached(StyleRefinement::default().w_full().h(size::HEADER)),
				),
			)
			.children(self.paused.then(|| {
				let app = self.app.clone();
				div()
					.w_full()
					.flex()
					.items_center()
					.gap(space::S3)
					.px(space::S4)
					.py(space::S1_5)
					.bg(palette.bg.surface)
					.border_b_1()
					.border_color(palette.border.subtle)
					.type_style(text::SMALL)
					.text_color(palette.status.waiting)
					.child("Agents are paused. Every turn waits until they resume.")
					.child(Button::new("thread-resume", "Resume").on_click(move |_, _, cx| {
						app.update(cx, |app, cx| {
							app.dispatch(HostAction::ResumeAgents, SurfaceId::AgentsResumeButton, cx);
						});
					}))
			}))
			.child(
				div().flex_1().min_h_0().w_full().child(
					self
						.transcript
						.clone()
						.cached(StyleRefinement::default().size_full()),
				),
			)
	}
}
