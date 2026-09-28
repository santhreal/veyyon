//! The thread header: 44 px, the window's drag region beside the sidebar.
//!
//! Left: the thread's title and where it works (directory, branch, pull
//! request, machine). Right: what the session runs as and costs (mode, model,
//! pace, serving account, quota, tokens, context) and the thread's controls.

use std::fmt::Write as _;

use gpui::{Context, Entity, Render, Subscription, Window, WindowControlArea, div, prelude::*};
use veyyon_desktop_model::{HostAction, SessionId, SessionMode, SurfaceId, domain::ShareRole};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use crate::{
	AppState, StoreEvent,
	actions::workspace::{ShowPanelTab, ToggleDrawer, TogglePanel},
	transcript::{tool::open_external, turn::duration_words},
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

/// The words a mode chip reads, or `None` for a session in no mode.
#[must_use]
pub fn mode_label(mode: &SessionMode) -> Option<String> {
	match mode {
		SessionMode::Plan => Some("Plan".to_owned()),
		SessionMode::PlanPaused => Some("Plan paused".to_owned()),
		SessionMode::Goal => Some("Goal".to_owned()),
		SessionMode::Vibe => Some("Vibe".to_owned()),
		SessionMode::Loop => Some("Loop".to_owned()),
		SessionMode::Other(name) if name == "none" || name.is_empty() => None,
		SessionMode::Other(name) => Some(name.replace(['_', '-'], " ")),
	}
}

/// `12.3k`, `1.2M`, `950`.
#[must_use]
pub fn compact_count(count: u64) -> String {
	match count {
		0..1_000 => count.to_string(),
		1_000..1_000_000 => format!("{}.{}k", count / 1_000, (count % 1_000) / 100),
		_ => format!("{}.{}M", count / 1_000_000, (count % 1_000_000) / 100_000),
	}
}

/// The chips the header states about `session`, left to right, read at
/// render so a running duration needs no timer.
#[must_use]
pub fn status_chips(app: &AppState, session: &SessionId, now_ms: u64) -> Vec<String> {
	let store = app.store();
	let domains = &store.domains;
	let mut chips = Vec::new();
	if let Some(mode) = app.session_mode(session).and_then(mode_label) {
		chips.push(mode);
	}
	if let Some(current) = domains
		.models
		.as_ref()
		.and_then(|models| models.current.as_ref())
	{
		chips.push(current.id.clone());
	}
	if let Some(pace) = store.pace(session) {
		let worked = duration_words(pace.worked_ms_at(now_ms) / 1000);
		match pace.tokens_per_second_tenths {
			Some(rate) => chips.push(format!("{}.{} tok/s · {worked}", rate / 10, rate % 10)),
			None => chips.push(worked),
		}
	}
	if let Some(account) = store
		.serving_account(session)
		.filter(|account| account.logins >= 2)
	{
		let predicted = if account.predicted { "~" } else { "" };
		chips.push(format!("{predicted}{}", account.label));
	}
	if let Some(quota) = store.quota(session) {
		let window = |label: &str, window: Option<&veyyon_desktop_model::domain::QuotaWindowView>| {
			window.map(|window| format!("{label} {}%", window.used_permille / 10))
		};
		let parts: Vec<String> =
			[window("5h", quota.five_hour.as_ref()), window("7d", quota.seven_day.as_ref())]
				.into_iter()
				.flatten()
				.collect();
		if !parts.is_empty() {
			chips.push(parts.join(" · "));
		}
	}
	if let Some(usage) = domains.usage.get(session) {
		let mut words =
			format!("↑{} ↓{}", compact_count(usage.input_tokens), compact_count(usage.output_tokens));
		if let Some(cost) = usage.cost_microusd {
			let _ = write!(words, " · ${}.{:02}", cost / 1_000_000, (cost % 1_000_000) / 10_000);
		}
		chips.push(words);
	}
	if let Some(context) = domains.context.get(session)
		&& let Some(limit) = context.limit_tokens.filter(|limit| *limit > 0)
	{
		chips.push(format!("{}% context", context.total_tokens * 100 / limit));
	}
	chips
}

fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

impl Render for ThreadHeader {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let app = self.app.read(cx);
		let session = app.active_session().cloned();
		let store = app.store();
		let title = session
			.as_ref()
			.and_then(|session| app.session_title(session))
			.map_or_else(|| "New thread".to_owned(), str::to_owned);
		let mut place = Vec::new();
		if let Some(cwd) = session.as_ref().and_then(|session| app.cwd(session)) {
			place.push(
				cwd.rsplit(['/', '\\'])
					.find(|part| !part.is_empty())
					.unwrap_or(cwd)
					.to_owned(),
			);
		}
		let checkout = session
			.as_ref()
			.and_then(|session| store.checkout(session))
			.cloned();
		if let Some(host) = &store.domains.host {
			place.push(
				host
					.hostname
					.split('.')
					.next()
					.unwrap_or(&host.hostname)
					.to_owned(),
			);
		}
		let chips = session
			.as_ref()
			.map(|session| status_chips(app, session, now_ms()))
			.unwrap_or_default();
		let share = store.domains.share.as_ref().map(|share| share.role);
		let paused = store.paused.paused;
		let muted = palette.text.muted;
		let pr = checkout
			.as_ref()
			.and_then(|checkout| checkout.pull_request.clone())
			.map(|pr| {
				let app = self.app.clone();
				div()
					.id("thread-pr")
					.text_color(palette.status.info)
					.cursor_pointer()
					.child(format!("#{}", pr.number))
					.on_click(move |_, _, cx| open_external(&app, pr.url.clone(), cx))
			});
		let branch = checkout.map(|checkout| {
			let dirty = if checkout.dirty { "*" } else { "" };
			div()
				.text_color(muted)
				.child(format!("⎇ {}{dirty}", checkout.branch))
		});
		let share_chip = match share {
			Some(ShareRole::Hosting) => Some("Sharing"),
			Some(ShareRole::Guest) => Some("Joined"),
			Some(ShareRole::Off) | None => None,
		};
		let pause = self.host_button(
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
					"thread-compact",
					IconName::Archive,
					"Compact context",
					HostAction::CompactSession { session: session.clone() },
					SurfaceId::SessionCompactButton(session.clone()),
				),
				self.host_button(
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
			.child(
				div()
					.flex_shrink_0()
					.type_style(text::TITLE)
					.text_color(palette.text.primary)
					.child(title),
			)
			.child(
				div()
					.flex()
					.min_w_0()
					.gap(space::S2)
					.text_color(muted)
					.children(place.into_iter().map(|part| div().truncate().child(part)))
					.children(branch)
					.children(pr),
			)
			.child(div().flex_1())
			.children(chips.into_iter().map(|chip| {
				div()
					.px(space::S2)
					.rounded(radius::SM)
					.bg(palette.bg.hover)
					.type_style(text::SMALL)
					.text_color(palette.text.secondary)
					.whitespace_nowrap()
					.child(chip)
			}))
			.children(share_chip.map(|chip| {
				div()
					.type_style(text::SMALL)
					.text_color(palette.status.info)
					.child(chip)
			}))
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
					.on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleDrawer), cx)),
			)
			.child(
				IconButton::new("thread-panel", IconName::PanelRight)
					.tooltip("Right panel")
					.on_click(|_, window, cx| window.dispatch_action(Box::new(TogglePanel), cx)),
			)
	}
}

impl ThreadHeader {
	fn host_button(
		&self,
		id: &'static str,
		icon: IconName,
		label: &'static str,
		action: HostAction,
		surface: SurfaceId,
	) -> IconButton {
		let app = self.app.clone();
		IconButton::new(id, icon)
			.tooltip(label)
			.on_click(move |_, _, cx| {
				let (action, surface) = (action.clone(), surface.clone());
				app.update(cx, |app, cx| {
					app.dispatch(action, surface, cx);
				});
			})
	}
}
