//! The thread header: 44 px, the window's drag region beside the sidebar.
//!
//! Left: the thread's title. Then its facts: where it works (directory,
//! machine, branch, pull request) and what the session runs as and costs
//! (sharing, mode, model, pace and the extensions' statuses, serving
//! account, quota, tokens, context). Right: the thread's controls and the
//! window's minimize, maximize and close buttons. The title takes at most
//! half the header and truncates past that. A header too narrow for every
//! fact drops the trailing ones whole, and the title narrows below its own
//! width only once no fact is left.

use gpui::{
	AnyElement, Context, Entity, MouseButton, Render, Subscription, Window, WindowControlArea, div,
	prelude::*, relative,
};
use veyyon_desktop_model::{HostAction, SurfaceId, domain::ShareRole};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::status::{now_ms, status_chips};
use crate::{
	AppState, StoreEvent,
	actions::workspace::{ShowPanelTab, ToggleDrawer, TogglePanel},
	driver,
	transcript::tool::open_external,
	workspace,
};

/// The thread header region.
pub struct ThreadHeader {
	app:           Entity<AppState>,
	_subscription: Subscription,
}

impl ThreadHeader {
	/// Creates the header over `app`.
	pub fn new(app: Entity<AppState>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |_, _, event: &StoreEvent, cx| match event {
			StoreEvent::ActiveSessionChanged
			| StoreEvent::SessionsChanged
			| StoreEvent::DomainChanged(_)
			| StoreEvent::ConnectionChanged => cx.notify(),
			_ => {},
		});
		Self { app, _subscription: subscription }
	}
}

impl Render for ThreadHeader {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let app = self.app.read(cx);
		let session = app.active_session().cloned();
		let store = app.store();
		let title = session
			.as_ref()
			.and_then(|session| app.session_title(session))
			.map_or_else(|| "New thread".to_owned(), str::to_owned);
		let muted = palette.text.muted;
		let mut place: Vec<AnyElement> = Vec::new();
		if let Some(cwd) = session.as_ref().and_then(|session| app.cwd(session)) {
			let dir = cwd
				.rsplit(['/', '\\'])
				.find(|part| !part.is_empty())
				.unwrap_or(cwd);
			place.push(div().child(dir.to_owned()).into_any_element());
		}
		if let Some(host) = &store.domains.host {
			let machine = host.hostname.split('.').next().unwrap_or(&host.hostname);
			place.push(div().child(machine.to_owned()).into_any_element());
		}
		if let Some(checkout) = session.as_ref().and_then(|session| store.checkout(session)) {
			let dirty = if checkout.dirty { "*" } else { "" };
			place.push(
				div()
					.child(format!("⎇ {}{dirty}", checkout.branch))
					.into_any_element(),
			);
			if let Some(pr) = checkout.pull_request.clone() {
				let app = self.app.clone();
				place.push(
					div()
						.id("thread-pr")
						.text_color(palette.status.info)
						.cursor_pointer()
						// The facts move the window when pressed; the link opens instead.
						.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
						.on_click(move |_, _, cx| open_external(&app, pr.url.clone(), cx))
						.child(format!("#{}", pr.number))
						.into_any_element(),
				);
			}
		}
		let share_chip = match store.domains.share.as_ref().map(|share| share.role) {
			Some(ShareRole::Hosting) => Some("Sharing"),
			Some(ShareRole::Guest) => Some("Joined"),
			Some(ShareRole::Off) | None => None,
		};
		let status = session
			.as_ref()
			.map(|session| status_chips(app, session, now_ms()))
			.unwrap_or_default();
		let chips: Vec<AnyElement> = share_chip
			.map(|chip| {
				div()
					.type_style(text::SMALL)
					.text_color(palette.status.info)
					.child(chip)
					.into_any_element()
			})
			.into_iter()
			.chain(status.into_iter().map(|chip| {
				div()
					.px(space::S2)
					.rounded(radius::SM)
					.bg(palette.bg.hover)
					.type_style(text::SMALL)
					.text_color(palette.text.secondary)
					.child(chip)
					.into_any_element()
			}))
			.collect();
		let paused = store.paused.paused;
		let pause = self.host_button(
			app,
			"thread-pause",
			if paused {
				IconName::Play
			} else {
				IconName::Pause
			},
			if paused {
				"Resume agents"
			} else {
				"Pause agents"
			},
			if paused {
				HostAction::ResumeAgents
			} else {
				HostAction::PauseAgents
			},
			if paused {
				SurfaceId::AgentsResumeButton
			} else {
				SurfaceId::AgentsPauseButton
			},
		);
		let session_buttons = session.map(|session| {
			[
				self.host_button(
					app,
					"thread-compact",
					IconName::Archive,
					"Compact context",
					HostAction::CompactSession { session: session.clone() },
					SurfaceId::SessionCompactButton(session.clone()),
				),
				self.host_button(
					app,
					"thread-export",
					IconName::FileText,
					"Export as Markdown",
					HostAction::ExportSession {
						session: session.clone(),
						format:  "markdown".to_owned(),
					},
					SurfaceId::SessionExportButton(session),
				),
				self.host_button(
					app,
					"thread-share",
					IconName::Globe,
					if share_chip.is_some() {
						"Stop sharing"
					} else {
						"Share thread"
					},
					if share_chip.is_some() {
						HostAction::StopShare
					} else {
						HostAction::StartShare { read_only: false }
					},
					if share_chip.is_some() {
						SurfaceId::ShareStopButton
					} else {
						SurfaceId::ShareStartButton
					},
				),
			]
		});
		let window_controls = workspace::window_controls(window, cx);
		div()
			.h(size::HEADER)
			.w_full()
			.flex()
			.items_center()
			.gap(space::S3)
			.px(space::S4)
			.border_b_1()
			.border_color(palette.border.subtle)
			.bg(palette.bg.app)
			.type_style(text::UI)
			.window_control_area(WindowControlArea::Drag)
			.child(workspace::drag_region(
				div()
					.min_w_0()
					.max_w(relative(0.5))
					.truncate()
					.type_style(text::TITLE)
					.text_color(palette.text.primary)
					.child(title),
			))
			.child(workspace::drag_region(
				div()
					.flex_1()
					.min_w_0()
					.h_full()
					.flex()
					.items_center()
					.text_color(muted)
					.child(facts(place, chips)),
			))
			.child(driver::target(
				"thread.buttons",
				div()
					.flex()
					.flex_none()
					.items_center()
					.gap(space::S1)
					.child(
						IconButton::new("thread-usage", IconName::Zap)
							.tooltip("Usage and context")
							.on_click(|_, window, cx| {
								window.dispatch_action(Box::new(ShowPanelTab { tab: "usage".into() }), cx);
							}),
					)
					.children(session_buttons.into_iter().flatten())
					.child(driver::target("thread.pause", pause))
					.child(
						IconButton::new("thread-drawer", IconName::PanelBottom)
							.tooltip("Terminal drawer")
							.on_click(|_, window, cx| {
								window.dispatch_action(Box::new(ToggleDrawer), cx);
							}),
					)
					.child(
						IconButton::new("thread-panel", IconName::PanelRight)
							.tooltip("Right panel")
							.on_click(|_, window, cx| {
								window.dispatch_action(Box::new(TogglePanel), cx);
							}),
					),
			))
			.child(window_controls)
	}
}

/// The header's facts: as many as fit, in order, and none of the rest.
///
/// One wrapping row, one control high, that clips its second line. A fact
/// that does not fit beside the ones before it wraps there whole, so a
/// narrow header drops the trailing facts, chips before places, instead of
/// drawing them over each other. The empty first item, one line high, keeps
/// even the first fact from overflowing its line, since a flex line always
/// takes its first item however wide, and holds that line's height when no
/// fact fits on it. The row's parent grows from nothing into the width the
/// title, the buttons and the window controls leave, so no fact narrows the
/// title.
fn facts(place: Vec<AnyElement>, chips: Vec<AnyElement>) -> impl IntoElement {
	let slot = |fact: AnyElement| {
		div()
			.flex()
			.flex_none()
			.items_center()
			.h(size::CONTROL_SM)
			.child(fact)
	};
	driver::target(
		"thread.facts",
		div()
			.w_full()
			.h(size::CONTROL_SM)
			.flex()
			.flex_wrap()
			.overflow_hidden()
			.whitespace_nowrap()
			.child(div().h(size::CONTROL_SM))
			.children(place.into_iter().map(|fact| slot(fact).mr(space::S2)))
			.child(div().flex_1().h(size::CONTROL_SM))
			.children(chips.into_iter().map(|fact| slot(fact).ml(space::S2))),
	)
}

impl ThreadHeader {
	/// A button sending `action` for `surface`, drawn disabled with the
	/// host's reason as its tooltip while the host takes no such action.
	fn host_button(
		&self,
		app: &AppState,
		id: &'static str,
		icon: IconName,
		label: &'static str,
		action: HostAction,
		surface: SurfaceId,
	) -> IconButton {
		let refusal = app.refusal(action.kind());
		let disabled = refusal.is_some();
		let state = self.app.clone();
		IconButton::new(id, icon)
			.tooltip(refusal.unwrap_or_else(|| label.to_owned()))
			.disabled(disabled)
			.on_click(move |_, _, cx| {
				let (action, surface) = (action.clone(), surface.clone());
				state.update(cx, |app, cx| {
					app.dispatch(action, surface, cx);
				});
			})
	}
}
