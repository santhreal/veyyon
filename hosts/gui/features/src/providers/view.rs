//! Provider-instance cards, authentication, and corrective actions.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AuthState, ProviderView, Versioned},
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, RetainedKey},
	theme::{Theme, space},
	ui::{Badge, Banner, Card, Empty, Fill, Icon, SearchField, Size, Tone, text},
};

use super::logic::{self, ProviderStatus, VirtualWindow};
use crate::{act, settings::remote};

const PAGE_ROWS: usize = 32;
const SEARCH_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Settings, 6);

pub fn render(store: &Store, field: &Entity<Editor>, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.auth,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading providers",
			empty:       "No provider instances are configured",
			empty_note:  "Provider instances appear here after they are configured by the engine.",
			detached:    "Providers are not loaded",
			unavailable: "Provider status is unavailable",
		},
		UiCommand::RefreshAuth,
		|versioned: &Versioned<AuthState>, mutable, cx| {
			page(&versioned.value, &store.frontend.provider_query, field, mutable, cx)
		},
		cx,
	)
}

fn page(
	auth: &AuthState,
	query: &str,
	field: &Entity<Editor>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	text::stack(space::LOOSE)
		.child(
			div()
				.flex()
				.items_center()
				.justify_between()
				.child(text::title("Providers", &theme))
				.child({
					let mut btn =
						crate::settings::controls::button("refresh-providers", "Refresh status")
							.icon(Icon::Running)
							.fill(Fill::Ghost);
					if !mutable {
						btn = btn.disabled("Provider status is read-only");
					} else {
						btn = btn.on_click(act::click(UiCommand::RefreshAuth));
					}
					btn
				}),
		)
		.child(SearchField::new("provider-filter", SEARCH_OWNER, field.clone()))
		.child(provider_content(
			auth,
			query,
			VirtualWindow { first: 0, rows: PAGE_ROWS },
			mutable,
			cx,
		))
		.into_any_element()
}

/// Searchable, bounded provider-instance list for settings and pickers.
pub fn provider_content(
	auth: &AuthState,
	query: &str,
	window: VirtualWindow,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	remote::render(
		&auth.providers,
		remote::mutation_state(mutable),
		remote::Copy {
			loading:     "Loading provider instances",
			empty:       "No provider instances",
			empty_note:  "Configure a provider in the engine, then refresh status.",
			detached:    "Provider instances disconnected",
			unavailable: "Provider instances are unavailable",
		},
		UiCommand::RefreshProviders,
		|_, content_mutable, cx| cards(auth, query, window, content_mutable, cx),
		cx,
	)
}

fn cards(
	auth: &AuthState,
	query: &str,
	window: VirtualWindow,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let providers = logic::filtered(auth, query, window);
	if providers.is_empty() {
		return Empty::new(if query.trim().is_empty() {
			"No provider instances"
		} else {
			"No providers match this search"
		})
		.icon(Icon::Search)
		.note("Try the provider name or exact instance id.")
		.into_any_element();
	}
	let mut stack = text::stack(space::BASE);
	for provider in providers {
		stack = stack.child(card(auth, provider, mutable, cx));
	}
	stack.into_any_element()
}

fn card(auth: &AuthState, provider: &ProviderView, mutable: bool, _cx: &mut App) -> Card {
	let status = logic::status(provider);
	let (label, tone) = match status {
		ProviderStatus::Ready => ("Ready", Tone::Ok),
		ProviderStatus::AuthRequired => ("Authentication required", Tone::Warn),
		ProviderStatus::Unavailable(_) => ("Unavailable", Tone::Muted),
		ProviderStatus::Failed(_) => ("Failed", Tone::Danger),
	};
	let mut card = Card::new().full_width().child(
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(px(space::BASE))
			.child(
				text::stack(space::PAIR)
					.flex_1()
					.min_w(px(0.0))
					.child(text::line(provider.name.clone()))
					.child(Badge::new(provider.id.to_string()).exact().bare()),
			)
			.child(Badge::new(label).tone(tone)),
	);

	match status {
		ProviderStatus::AuthRequired => {
			card = card.child(Banner::waiting("Authentication is required").child({
				let mut btn = crate::settings::controls::button(
					format!("provider-auth-{}", provider.id),
					"Authenticate",
				)
				.icon(Icon::Allow)
				.fill(Fill::Tinted)
				.tone(Tone::Warn)
				.size(Size::Small);
				if !mutable {
					btn = btn.disabled("Authentication is read-only");
				} else {
					btn = btn.on_click(act::click(UiCommand::StartProviderAuth(provider.id.clone())));
				}
				btn
			}));
		},
		ProviderStatus::Unavailable(reason) => {
			card =
				card.child(Banner::notice("Provider instance unavailable").detail(reason.to_owned()));
		},
		ProviderStatus::Failed(message) => {
			card = card.child(Banner::failure("Provider instance failed").detail(message.to_owned()));
		},
		ProviderStatus::Ready => {},
	}

	let accounts = logic::accounts_for(auth, &provider.id);
	if !accounts.is_empty() {
		let mut rows = text::stack(space::ROWS);
		for account in accounts {
			let mut row = crate::settings::controls::row(
				format!("provider-account-{}", account.id),
				account.label.clone(),
			)
			.note(account.status.clone());
			if account.selected {
				row = row.child(Badge::new("Current").icon(Icon::Check).tone(Tone::Accent));
			}
			rows = rows.child(row);
		}
		card = card.child(rows);
	}
	card
}
