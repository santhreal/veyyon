//! The strip over the thread column while the host holds every agent frozen:
//! how long the freeze has run and the control that ends it.
//!
//! The freeze belongs to the host process, not to a session, so the strip is
//! drawn over the thread, the empty state and settings alike. The host states
//! the wall clock the freeze began on, so a window that attaches mid-freeze
//! states the time already run rather than counting from zero. That offset is
//! read once, when the host states the freeze, and counted on from the
//! executor's clock, which a wall clock stepping back cannot run backwards.
//! The strip redraws once a second while the freeze holds, and not at all
//! while agents run.

use std::time::{Duration, Instant};

use gpui::{Context, Entity, Render, Subscription, Task, Window, div, prelude::*};
use veyyon_desktop_model::{
	AgentPauseView, HostAction, HostActionKind, SnapshotSectionKind, SurfaceId,
};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize},
	theme::{ActiveTheme, TypeStyled, space, text},
};

use super::notices::now_ms;
use crate::{AppState, StoreEvent, transcript::turn::duration_words};

/// How often the strip's duration is redrawn.
const TICK: Duration = Duration::from_secs(1);

/// The freeze strip, drawn while the host holds every agent frozen.
pub struct FreezeStrip {
	app:           Entity<AppState>,
	/// The host's statement the strip reads.
	held:          AgentPauseView,
	/// How long the freeze had run when the host stated it, and the
	/// executor's instant then; `None` while agents run and for a freeze the
	/// host states no start for.
	anchor:        Option<(u64, Instant)>,
	/// Redraws the strip once a second while the freeze holds.
	tick:          Option<Task<()>>,
	/// How many times the strip has rendered.
	renders:       usize,
	_subscription: Subscription,
}

impl FreezeStrip {
	/// A strip that follows the freeze `app` states.
	pub(super) fn new(app: Entity<AppState>, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |this, app, event: &StoreEvent, cx| {
			let redraw = match event {
				StoreEvent::DomainChanged(SnapshotSectionKind::AgentPause) => {
					let stated = app.read(cx).store().paused;
					this.sync(stated, cx)
				},
				// The resume control reads the host's gate.
				StoreEvent::DomainChanged(SnapshotSectionKind::Capabilities)
				| StoreEvent::ConnectionChanged => this.held.paused,
				_ => false,
			};
			if redraw {
				cx.notify();
			}
		});
		let stated = app.read(cx).store().paused;
		let mut strip = Self {
			app,
			held: AgentPauseView::RUNNING,
			anchor: None,
			tick: None,
			renders: 0,
			_subscription: subscription,
		};
		strip.sync(stated, cx);
		strip
	}

	/// How many times the strip has rendered.
	#[must_use]
	pub const fn render_count(&self) -> usize {
		self.renders
	}

	/// Takes the freeze the host `stated`; `true` when it differs from the one
	/// drawn. A changed freeze is anchored again and ticks while it holds.
	fn sync(&mut self, stated: AgentPauseView, cx: &Context<Self>) -> bool {
		if stated == self.held {
			return false;
		}
		self.held = stated;
		self.anchor = stated
			.elapsed_ms(now_ms())
			.map(|ran| (ran, cx.background_executor().now()));
		self.tick = stated.paused.then(|| {
			cx.spawn(async move |this, cx| {
				loop {
					cx.background_executor().timer(TICK).await;
					if this.update(cx, |_, cx| cx.notify()).is_err() {
						break;
					}
				}
			})
		});
		true
	}

	/// The line the strip states.
	fn line(&self, cx: &Context<Self>) -> String {
		let Some((ran, at)) = self.anchor else {
			return "Agents are paused. Every turn waits until they resume.".to_owned();
		};
		let since = cx
			.background_executor()
			.now()
			.saturating_duration_since(at)
			.as_millis();
		let ran = ran.saturating_add(u64::try_from(since).unwrap_or(u64::MAX));
		format!(
			"Agents paused for {}. Every turn waits until they resume.",
			duration_words(ran / 1000)
		)
	}
}

impl Render for FreezeStrip {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let refusal = self.app.read(cx).refusal(HostActionKind::ResumeAgents);
		let app = self.app.clone();
		let resume = Button::new("freeze-resume", "Resume")
			.size(ButtonSize::Sm)
			.disabled(refusal.is_some())
			.on_click(move |_, _, cx| {
				app.update(cx, |app, cx| {
					app.dispatch(HostAction::ResumeAgents, SurfaceId::AgentsResumeButton, cx);
				});
			});
		div()
			.debug_selector(|| "freeze".to_owned())
			.size_full()
			.flex()
			.items_center()
			.gap(space::S3)
			.px(space::S4)
			.bg(palette.bg.surface)
			.border_b_1()
			.border_color(palette.border.subtle)
			.type_style(text::SMALL)
			.text_color(palette.status.waiting)
			.child(div().min_w_0().truncate().child(self.line(cx)))
			.child(
				div()
					.debug_selector(|| "freeze-resume".to_owned())
					.child(resume),
			)
			.children(refusal.map(|reason| div().text_color(palette.text.faint).child(reason)))
	}
}
