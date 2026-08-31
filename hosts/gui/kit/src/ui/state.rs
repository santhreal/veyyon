//! Empty, loading, stale, and error presentation.
//!
//! This module contains presentation values only. Product `RemoteData<T>` is
//! mapped into one of these variants by a feature; kit never imports that
//! state. Stale content remains mounted beneath its banner. Retry exists only
//! when the caller supplies a listener.

use gpui::{
	AnyElement, App, ClickEvent, IntoElement, ParentElement, RenderOnce, SharedString, Styled,
	Window, div, px,
};

use super::{Banner, Button, Fill, Icon, Spinner, Tone, text};
use crate::{
	motion::RetainedKey,
	theme::{Theme, layout, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateKind {
	Empty,
	Loading,
	Stale,
	Error,
}

#[derive(IntoElement)]
pub struct StateSurface {
	owner:   RetainedKey,
	kind:    StateKind,
	title:   SharedString,
	detail:  Option<SharedString>,
	content: Vec<AnyElement>,
	retry:   Option<Click>,
	fill:    bool,
}

impl StateSurface {
	pub fn empty(owner: RetainedKey, title: impl Into<SharedString>) -> Self {
		Self::new(owner, StateKind::Empty, title)
	}

	pub fn loading(owner: RetainedKey, title: impl Into<SharedString>) -> Self {
		Self::new(owner, StateKind::Loading, title)
	}

	pub fn stale(owner: RetainedKey, title: impl Into<SharedString>) -> Self {
		Self::new(owner, StateKind::Stale, title)
	}

	pub fn error(owner: RetainedKey, title: impl Into<SharedString>) -> Self {
		Self::new(owner, StateKind::Error, title)
	}

	fn new(owner: RetainedKey, kind: StateKind, title: impl Into<SharedString>) -> Self {
		Self {
			owner,
			kind,
			title: title.into(),
			detail: None,
			content: Vec::new(),
			retry: None,
			fill: false,
		}
	}

	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	pub fn filling(mut self) -> Self {
		self.fill = true;
		self
	}

	pub fn on_retry(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.retry = Some(Box::new(listener));
		self
	}
}

impl ParentElement for StateSurface {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.content.extend(elements);
	}
}

impl RenderOnce for StateSurface {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let mut root = div().flex().flex_col().w_full();
		if self.fill {
			root = root.size_full();
		}
		if self.kind == StateKind::Stale {
			let mut banner = Banner::new(Tone::Warn, self.title).icon(Icon::Notice);
			if let Some(detail) = self.detail {
				banner = banner.detail(detail);
			}
			return root
				.gap(px(space::SNUG))
				.child(banner)
				.children(self.content);
		}
		let (icon, tone) = match self.kind {
			StateKind::Empty => (Icon::Notice, Tone::Muted),
			StateKind::Loading => (Icon::Running, Tone::Accent),
			StateKind::Error => (Icon::Failed, Tone::Danger),
			StateKind::Stale => (Icon::Notice, Tone::Warn),
		};
		let mut center = div()
			.flex()
			.flex_col()
			.items_center()
			.justify_center()
			.gap(px(space::BASE))
			.max_w(px(layout::measure()))
			.m_auto()
			.text_color(tone.ink(&theme));
		center = if self.kind == StateKind::Loading {
			center.child(Spinner::new(self.owner, icon))
		} else {
			center.child(super::icon::at(icon, super::icon::scale::large(), tone.ink(&theme)))
		};
		center = center.child(text::line(self.title).text_color(theme.text));
		if let Some(detail) = self.detail {
			center = center.child(text::note(detail, &theme));
		}
		if let Some(retry) = self.retry {
			center = center.child(
				Button::labelled("state-retry", self.owner, "Retry")
					.icon(Icon::Retry)
					.fill(Fill::Tinted)
					.tone(Tone::Accent)
					.on_click(retry),
			);
		}
		root.child(center)
	}
}
