//! Native command hierarchy and shared intermediate surface chrome.

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_gpui::{Context, Div, ParentElement, Styled, div};

use crate::{
	Intent, Overlay, PaletteState, ShellView,
	palette::PaletteItem,
	settings::{SettingsPage, SettingsState},
};

/// UI destinations over existing host domain renderers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceRoute {
	Commands,
	Account,
	Settings,
	Page(SettingsPage),
}

impl SurfaceRoute {
	#[must_use]
	pub const fn title(self) -> &'static str {
		match self {
			Self::Commands => "Commands",
			Self::Account => "Account",
			Self::Settings => "Settings",
			Self::Page(SettingsPage::Providers) => "Account manager",
			Self::Page(SettingsPage::Authentication) => "Sign in",
			Self::Page(SettingsPage::Extensions) => "Agents",
			Self::Page(page) => page.title(),
		}
	}

	#[must_use]
	pub const fn parent(self) -> Option<Self> {
		match self {
			Self::Commands => None,
			Self::Account | Self::Settings => Some(Self::Commands),
			Self::Page(SettingsPage::Providers | SettingsPage::Authentication) => Some(Self::Account),
			Self::Page(
				SettingsPage::General
				| SettingsPage::Themes
				| SettingsPage::Keybindings
				| SettingsPage::Diagnostics,
			) => Some(Self::Settings),
			Self::Page(_) => Some(Self::Commands),
		}
	}

	#[must_use]
	pub const fn aliases(self) -> &'static [&'static str] {
		match self {
			Self::Page(SettingsPage::Providers) => &["/providers"],
			Self::Page(SettingsPage::Authentication) => &["/login"],
			Self::Page(SettingsPage::Extensions) => &["/extensions"],
			_ => &[],
		}
	}

	#[must_use]
	pub fn overlay(self) -> Overlay {
		if let Self::Page(page) = self {
			let mut state = SettingsState::new(page);
			state.route = Some(self);
			return Overlay::Settings(Box::new(state));
		}
		let mut palette = PaletteState::commands();
		palette.route = Some(self);
		if self != Self::Commands {
			palette.items = SettingsPage::iter()
				.filter(|page| Self::Page(*page).parent() == Some(self))
				.map(page_item)
				.collect();
		}
		Overlay::Palette(palette)
	}
}

fn page_item(page: SettingsPage) -> PaletteItem {
	let route = SurfaceRoute::Page(page);
	let mut item =
		PaletteItem::command(page as u64 + 100, route.title(), Intent::Navigate(route), None);
	item.subtitle = Some(page.description().to_owned());
	item
}

/// The same back, title and close controls for intermediate groups and leaves.
pub fn surface_header(route: SurfaceRoute, tokens: &TokenSet, cx: &Context<ShellView>) -> Div {
	let mut header = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));
	if let Some(parent) = route.parent() {
		header = header.child(
			Button::new("Back")
				.id("surface-back")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _, _, cx| view.navigate_surface(parent, cx))),
		);
	}
	header
		.child(
			div()
				.flex_1()
				.text_size(tokens.font_size(TextRamp::Head))
				.font_weight(tokens.font_weight(TextWeight::Semibold))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(route.title()),
		)
		.child(
			Button::new("Close")
				.id("surface-close")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(|view, _, _, cx| view.close_palette(cx))),
		)
}
