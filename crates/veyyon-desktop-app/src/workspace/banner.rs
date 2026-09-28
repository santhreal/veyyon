//! The strip over the thread column that states a host link that is not up.

use gpui::{Context, Entity, Render, SharedString, Subscription, Window, div, prelude::*};
use veyyon_desktop_model::ConnectionState;
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize},
	theme::{ActiveTheme, TypeStyled, space, text},
};

use crate::{AppState, StoreEvent, actions::workspace as act};

/// The action the banner's button dispatches.
#[derive(Clone, Copy)]
enum Remedy {
	/// `workspace::Attach`, labelled "Attach".
	Attach,
	/// `workspace::RetryConnection`, labelled with the given text.
	Retry(&'static str),
}

/// What the banner states for one connection state.
struct Notice {
	line:   SharedString,
	/// A lost or failed link, drawn in the error color.
	lost:   bool,
	remedy: Option<Remedy>,
}

/// The connection banner: drawn while the link is detached, connecting,
/// retrying or failed, and absent while it is up.
pub(super) struct ConnectionBanner {
	app:           Entity<AppState>,
	_subscription: Subscription,
}

impl ConnectionBanner {
	/// A banner that redraws when the connection of `app` changes.
	pub(super) fn new(app: Entity<AppState>, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |_, _, event: &StoreEvent, cx| {
			if matches!(event, StoreEvent::ConnectionChanged) {
				cx.notify();
			}
		});
		Self { app, _subscription: subscription }
	}

	/// Whether the banner is drawn for `state`.
	pub(super) const fn shows(state: &ConnectionState) -> bool {
		!matches!(state, ConnectionState::Connected { .. } | ConnectionState::Syncing { .. })
	}
}

/// What the banner states for `state`.
fn notice(state: &ConnectionState) -> Notice {
	match state {
		ConnectionState::Detached => Notice {
			line:   "Not attached to a host.".into(),
			lost:   false,
			remedy: Some(Remedy::Attach),
		},
		ConnectionState::Connecting { attempt } if *attempt > 1 => Notice {
			line:   format!("Connecting to the host, attempt {attempt}.").into(),
			lost:   false,
			remedy: None,
		},
		ConnectionState::Connecting { .. } => {
			Notice { line: "Connecting to the host.".into(), lost: false, remedy: None }
		},
		ConnectionState::Reconnecting { attempt, message, .. } => Notice {
			line:   if message.is_empty() {
				format!("Connection lost. Retrying, attempt {attempt}.").into()
			} else {
				format!("Connection lost: {message}. Retrying, attempt {attempt}.").into()
			},
			lost:   true,
			remedy: Some(Remedy::Retry("Retry now")),
		},
		ConnectionState::Fatal { message } => Notice {
			line:   format!("Connection failed: {message}").into(),
			lost:   true,
			remedy: Some(Remedy::Retry("Retry")),
		},
		ConnectionState::Syncing { .. } | ConnectionState::Connected { .. } => {
			Notice { line: SharedString::default(), lost: false, remedy: None }
		},
	}
}

impl Render for ConnectionBanner {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let notice = notice(&self.app.read(cx).store().connection);
		div()
			.debug_selector(|| "connection-banner".to_owned())
			.size_full()
			.flex()
			.items_center()
			.gap(space::S3)
			.px(space::S4)
			.bg(palette.bg.surface)
			.border_b_1()
			.border_color(palette.border.subtle)
			.type_style(text::SMALL)
			.text_color(if notice.lost {
				palette.status.error
			} else {
				palette.text.muted
			})
			.child(div().flex_1().min_w_0().truncate().child(notice.line))
			.children(notice.remedy.map(|remedy| {
				let label = match remedy {
					Remedy::Attach => "Attach",
					Remedy::Retry(label) => label,
				};
				div()
					.debug_selector(|| "connection-banner-button".to_owned())
					.child(
						Button::new("connection-banner-button", label)
							.size(ButtonSize::Sm)
							.on_click(move |_, window, cx| match remedy {
								Remedy::Attach => window.dispatch_action(Box::new(act::Attach), cx),
								Remedy::Retry(_) => {
									window.dispatch_action(Box::new(act::RetryConnection), cx);
								},
							}),
					)
			}))
	}
}
