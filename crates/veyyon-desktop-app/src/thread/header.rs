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

mod share;

use gpui::{
	AnyElement, ClickEvent, Context, Entity, MouseButton, Render, Subscription, Window,
	WindowControlArea, div, prelude::*, relative,
};
use veyyon_desktop_model::{
	HostAction, HostActionKind, SnapshotSectionKind, SurfaceId,
	domain::{ExportFormat, ShareRole},
};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	overlays::ContextMenu,
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

/// The driver target of the sharing chip.
const CHIP: &str = "thread.share-links";

/// The thread header region.
pub struct ThreadHeader {
	app:            Entity<AppState>,
	/// The menu the sharing chip opens, and the link each of its rows copies.
	share_menu:     Entity<ContextMenu>,
	share_picks:    Vec<Option<String>>,
	/// The request each host button sends and whether one was in flight, as
	/// last drawn.
	drawn:          Vec<(HostActionKind, bool)>,
	_subscriptions: [Subscription; 2],
}

impl ThreadHeader {
	/// Creates the header over `app`.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let store = cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
			StoreEvent::DomainChanged(SnapshotSectionKind::Share) => {
				this.restate_share_menu(cx);
				cx.notify();
			},
			StoreEvent::ActiveSessionChanged
			| StoreEvent::SessionsChanged
			| StoreEvent::DomainChanged(_)
			| StoreEvent::ConnectionChanged => cx.notify(),
			// A press was sent or answered: redraw a button whose request
			// went in or out of flight.
			StoreEvent::OutboxReady | StoreEvent::RequestFinished { .. } => {
				let app = this.app.read(cx);
				let moved = this
					.drawn
					.iter()
					.any(|(kind, in_flight)| app.panel_pending(*kind) != *in_flight);
				if moved {
					cx.notify();
				}
			},
			_ => {},
		});
		let share_menu = cx.new(|cx| ContextMenu::new(Vec::new(), window, cx));
		let picked = cx.subscribe_in(&share_menu, window, Self::on_share_pick);
		Self {
			app,
			share_menu,
			share_picks: Vec::new(),
			drawn: Vec::new(),
			_subscriptions: [store, picked],
		}
	}
}

impl Render for ThreadHeader {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let role = self
			.app
			.read(cx)
			.store()
			.domains
			.share
			.as_ref()
			.map_or(ShareRole::Off, |share| share.role);
		let share_chip = share::chip(role);
		if share_chip.is_none() {
			driver::forget(window, CHIP, cx);
		}
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
		let status = session
			.as_ref()
			.map(|session| status_chips(app, session, now_ms()))
			.unwrap_or_default();
		let chips: Vec<AnyElement> = share_chip
			.map(|chip| {
				driver::target(
					CHIP,
					div()
						.id("thread-share-links")
						.type_style(text::SMALL)
						.text_color(palette.status.info)
						.cursor_pointer()
						// The facts move the window when pressed; the chip opens its menu instead.
						.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
						.on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
							this.open_share_menu(event.position(), window, cx);
						}))
						.child(chip),
				)
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
		let mut drawn = Vec::new();
		let (icon, label, action, surface) = if store.paused.paused {
			(IconName::Play, "Resume agents", HostAction::ResumeAgents, SurfaceId::AgentsResumeButton)
		} else {
			(IconName::Pause, "Pause agents", HostAction::PauseAgents, SurfaceId::AgentsPauseButton)
		};
		let pause = self.host_button(app, &mut drawn, "thread.pause", (icon, label), action, surface);
		let (share_label, share_action, share_surface) = match role {
			ShareRole::Off => (
				"Share thread",
				HostAction::StartShare { read_only: false },
				SurfaceId::ShareStartButton,
			),
			ShareRole::Hosting => ("Stop sharing", HostAction::StopShare, SurfaceId::ShareStopButton),
			ShareRole::Guest => {
				("Leave the share", HostAction::LeaveShare, SurfaceId::ShareLeaveButton)
			},
		};
		let session_buttons = session.map(|session| {
			[
				self.host_button(
					app,
					&mut drawn,
					"thread.compact",
					(IconName::Archive, "Compact context"),
					HostAction::CompactSession { session: session.clone() },
					SurfaceId::SessionCompactButton(session.clone()),
				),
				self.host_button(
					app,
					&mut drawn,
					"thread.export",
					(IconName::FileText, "Export as HTML"),
					HostAction::ExportSession { session: session.clone(), format: ExportFormat::Html },
					SurfaceId::SessionExportButton(session),
				),
				self.host_button(
					app,
					&mut drawn,
					"thread.share",
					(IconName::Globe, share_label),
					share_action,
					share_surface,
				),
			]
		});
		self.drawn = drawn;
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
					.child(pause)
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
			.child(self.share_menu.clone())
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
	/// A button sending `action` for `surface`, recorded in `drawn` with
	/// whether a request of its kind is in flight. It is drawn disabled while
	/// one is, and with the host's reason as its tooltip while the host takes
	/// no such action.
	fn host_button(
		&self,
		app: &AppState,
		drawn: &mut Vec<(HostActionKind, bool)>,
		id: &'static str,
		(icon, label): (IconName, &'static str),
		action: HostAction,
		surface: SurfaceId,
	) -> AnyElement {
		let kind = action.kind();
		let in_flight = app.panel_pending(kind);
		drawn.push((kind, in_flight));
		let refusal = app.refusal(kind);
		let disabled = refusal.is_some() || in_flight;
		let state = self.app.clone();
		driver::target(
			id,
			IconButton::new(id, icon)
				.tooltip(refusal.unwrap_or_else(|| label.to_owned()))
				.disabled(disabled)
				.on_click(move |_, _, cx| {
					let (action, surface) = (action.clone(), surface.clone());
					state.update(cx, |app, cx| {
						app.dispatch(action, surface, cx);
					});
				}),
		)
	}
}
