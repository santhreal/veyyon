//! The Providers page: each model provider and whether it is signed in, the
//! sign-in running now, and every stored account with its sign-out.

use veyyon_desktop_model::{
	AuthFlowState, AuthFlowView, HostAction, SurfaceId,
	action::AccountsRequest,
	domain::{CredentialKind, StoredAccountView},
};
use veyyon_desktop_ui::{
	controls::{ButtonVariant, DotStatus, StatusDot},
	theme::{ActiveTheme, Palette, TypeStyled, radius, space, text},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*};

use super::{
	Ask, Page, SettingsView,
	widgets::{heading, input_box, local_button, note, row, send_button, title},
};

/// The field key of the secret input.
const SECRET: &str = "auth-secret";

impl SettingsView {
	pub(super) fn providers(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let domains = &self.app.read(cx).store().domains;
		let providers = domains.providers.clone();
		let accounts = domains.accounts.clone();
		let flow = domains.auth_flow.clone();
		let mut page = div()
			.child(title(Page::Providers.label(), Page::Providers.description(), &palette))
			.child(send_button(
				"providers-refresh",
				"Refresh",
				ButtonVariant::Ghost,
				HostAction::RefreshProviders,
				SurfaceId::AuthRefreshButton,
				&self.app,
				cx,
			));
		if let Some(flow) = flow.filter(|flow| !super::mcp::owns_flow(&flow.provider)) {
			page = page.child(self.auth_flow(&flow, window, cx));
		}
		page = page.child(heading("Providers", &palette));
		if providers.is_empty() {
			page = page.child(note("Loading providers from the host…", &palette));
		}
		for provider in &providers {
			let status = if provider.authenticated {
				DotStatus::Success
			} else {
				DotStatus::Idle
			};
			let stored = accounts
				.iter()
				.any(|account| account.provider == provider.id);
			let mut how = Vec::new();
			if provider.oauth {
				how.push("sign-in");
			}
			if provider.api_key {
				how.push("API key");
			}
			let state = match (provider.authenticated, stored) {
				(true, true) => "Signed in",
				(true, false) => "Signed in from environment",
				(false, _) => "Not signed in",
			};
			let detail = format!("{state} · {}", how.join(" or "));
			let control = div()
				.flex()
				.items_center()
				.gap(space::S2)
				.child(StatusDot::new(status))
				.child(send_button(
					SharedString::from(format!("sign-in-{}", provider.id)),
					if provider.authenticated {
						"Sign in again"
					} else {
						"Sign in"
					},
					ButtonVariant::Secondary,
					HostAction::StartProviderAuth { provider: provider.id.clone() },
					SurfaceId::ProviderAuthStartButton(provider.id.clone()),
					&self.app,
					cx,
				));
			page = page.child(row(
				SharedString::from(format!("provider-{}", provider.id)),
				provider.name.clone(),
				Some(detail.into()),
				control.into_any_element(),
				&palette,
			));
		}
		page = page.child(self.anchored("accounts", heading("Stored accounts", &palette)));
		if accounts.is_empty() {
			page = page.child(note("No stored accounts", &palette));
		}
		let mut groups: Vec<(String, Vec<StoredAccountView>)> = Vec::new();
		for account in accounts {
			let name = providers
				.iter()
				.find(|provider| provider.id == account.provider)
				.map_or_else(|| account.provider.clone(), |provider| provider.name.clone());
			match groups.iter_mut().find(|(group, _)| *group == name) {
				Some((_, rows)) => rows.push(account),
				None => groups.push((name, vec![account])),
			}
		}
		for (name, rows) in groups {
			page = page.child(note(name, &palette));
			for account in rows {
				page = page.child(Self::account(account, &palette, cx));
			}
		}
		page.into_any_element()
	}

	fn account(account: StoredAccountView, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let kind = match account.kind {
			CredentialKind::Oauth => "OAuth",
			CredentialKind::ApiKey => "API key",
		};
		let detail = if account.selected {
			format!("{kind} · in use")
		} else {
			kind.to_owned()
		};
		let label = account.label.clone();
		let action = HostAction::Accounts(AccountsRequest::SignOutAccount {
			provider:      account.provider.clone(),
			credential_id: account.credential_id,
		});
		let surface = SurfaceId::SettingsField(format!(
			"account:{}:{}",
			account.provider, account.credential_id
		));
		let button = local_button(
			SharedString::from(format!("sign-out-{}-{}", account.provider, account.credential_id)),
			"Sign out",
			ButtonVariant::Ghost,
			cx.listener(move |this, _, window, cx| {
				this.confirm(
					Ask {
						title:   format!("Sign out of {label}?"),
						body:    "The stored credential is deleted. A key read from the environment or \
						          a config file still signs in."
							.to_owned(),
						label:   "Sign out",
						action:  action.clone(),
						surface: surface.clone(),
					},
					window,
					cx,
				);
			}),
		);
		row(
			SharedString::from(format!("account-{}-{}", account.provider, account.credential_id)),
			account.label,
			Some(detail.into()),
			button,
			palette,
		)
	}

	/// The sign-in running now: its state, the page to open, the secret it
	/// waits on, and cancel or retry.
	pub(super) fn auth_flow(
		&mut self,
		flow: &AuthFlowView,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let provider = flow.provider.clone();
		let (status, state) = match flow.state {
			AuthFlowState::AwaitingBrowser => (DotStatus::Waiting, "Waiting for the browser"),
			AuthFlowState::AwaitingSecret => (DotStatus::Waiting, "Waiting for a code or key"),
			AuthFlowState::Completed => (DotStatus::Success, "Signed in"),
			AuthFlowState::Failed => (DotStatus::Error, "Sign-in failed"),
			AuthFlowState::Cancelled => (DotStatus::Idle, "Sign-in cancelled"),
		};
		let mut card = div()
			.id("auth-flow")
			.mt(space::S4)
			.p(space::S3)
			.flex()
			.flex_col()
			.gap(space::S2)
			.rounded(radius::LG)
			.border_1()
			.border_color(palette.border.default)
			.bg(palette.bg.surface)
			.child(
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.type_style(text::UI_MEDIUM)
					.text_color(palette.text.primary)
					.child(StatusDot::new(status))
					.child(format!("{provider}: {state}")),
			);
		if let Some(message) = &flow.message {
			card = card.child(note(message.clone(), &palette));
		}
		if let Some(url) = &flow.url {
			card = card.child(
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.child(
						div()
							.flex_1()
							.min_w_0()
							.truncate()
							.type_style(text::MONO)
							.text_color(palette.text.secondary)
							.child(url.clone()),
					)
					.child(send_button(
						"auth-open-url",
						"Open sign-in page",
						ButtonVariant::Primary,
						HostAction::OpenAuthUrl { url: url.clone() },
						SurfaceId::ProviderAuthUrlOpen(provider.clone()),
						&self.app,
						cx,
					)),
			);
		}
		let mut buttons = div().flex().flex_wrap().gap(space::S2);
		let waiting =
			matches!(flow.state, AuthFlowState::AwaitingBrowser | AuthFlowState::AwaitingSecret);
		if waiting {
			let label = flow
				.prompt
				.clone()
				.unwrap_or_else(|| "Paste the code or API key".to_owned());
			let input = self.secret_field(SECRET, &label, submit_secret, window, cx);
			card = card
				.child(note(label, &palette))
				.child(input_box(SECRET, input, &palette));
			buttons = buttons.child(send_button(
				"auth-cancel",
				"Cancel",
				ButtonVariant::Ghost,
				HostAction::CancelAuthFlow { provider: provider.clone() },
				SurfaceId::ProviderAuthCancelButton(provider.clone()),
				&self.app,
				cx,
			));
		}
		if matches!(flow.state, AuthFlowState::Failed | AuthFlowState::Cancelled) {
			buttons = buttons.child(send_button(
				"auth-retry",
				"Try again",
				ButtonVariant::Secondary,
				HostAction::RetryAuthFlow { provider: provider.clone() },
				SurfaceId::ProviderAuthRetryButton(provider),
				&self.app,
				cx,
			));
		}
		card.child(buttons).into_any_element()
	}
}

/// Sends the secret typed for the sign-in running now and clears the input.
fn submit_secret(
	view: &mut SettingsView,
	key: &str,
	text: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	let secret = text.trim().to_owned();
	let provider = view
		.app
		.read(cx)
		.store()
		.domains
		.auth_flow
		.as_ref()
		.map(|flow| flow.provider.clone());
	let Some(provider) = provider.filter(|_| !secret.is_empty()) else {
		return;
	};
	view.set_field(key, "", cx);
	view.send(
		HostAction::SubmitAuthSecret { provider: provider.clone(), secret },
		SurfaceId::ProviderAuthSecretSubmit(provider),
		cx,
	);
}
