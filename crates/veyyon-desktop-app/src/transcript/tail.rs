//! The streaming tail: the reply the agent is writing, drawn as the last item
//! of the transcript list while it streams.
//!
//! The tail is its own entity so a delta notifies it and nothing else: only
//! the markdown block still growing is reparsed (`MarkdownDoc::append`). The
//! transcript drives it ([`StreamingTail::sync`]) and owns its list slot.
//! When the stream ends the tail holds the prose it drew until the committed
//! entry takes its slot ([`StreamingTail::release`]), so a reply never blinks
//! out between the end of the stream and the entry that records it.

use std::borrow::Cow;

use gpui::{Context, Entity, Render, Window, div, prelude::*};
use veyyon_desktop_model::{ContentBlock, SessionId};
use veyyon_desktop_ui::{
	markdown::{self, MarkdownDoc, MarkdownStyle},
	theme::{ActiveTheme, TypeStyled, size, space, text},
};

use super::tool::open_external;
use crate::AppState;

/// What the tail shows.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
	/// Nothing: no stream, and no ended reply held.
	Idle,
	/// The model is thinking and has written no prose yet.
	Thinking,
	/// A tool is running.
	Tool(String),
	/// Prose is arriving.
	Writing,
	/// The stream ended; the prose stays until its entry takes the slot.
	Held,
}

/// The streaming tail.
pub struct StreamingTail {
	app:     Entity<AppState>,
	doc:     MarkdownDoc,
	phase:   Phase,
	renders: usize,
}

impl StreamingTail {
	/// Creates an empty tail over `app`.
	#[must_use]
	pub fn new(app: Entity<AppState>) -> Self {
		Self { app, doc: MarkdownDoc::default(), phase: Phase::Idle, renders: 0 }
	}

	/// How many times the tail has rendered.
	#[must_use]
	pub const fn renders(&self) -> usize {
		self.renders
	}

	/// The prose the tail holds.
	#[must_use]
	pub fn text(&self) -> &str {
		self.doc.source()
	}

	/// Whether the tail draws nothing.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.phase == Phase::Idle
	}

	/// Reads `session`'s stream. An ended stream keeps the prose it wrote,
	/// held until [`Self::release`]; one that wrote none leaves the tail empty.
	pub(super) fn sync(&mut self, session: Option<&SessionId>, cx: &mut Context<Self>) {
		let app = self.app.read(cx);
		let Some(state) = session.and_then(|session| app.streaming(session)) else {
			let phase = if self.doc.source().is_empty() {
				Phase::Idle
			} else {
				Phase::Held
			};
			if phase != self.phase {
				self.phase = phase;
				cx.notify();
			}
			return;
		};
		let content = &state.accumulating.content;
		let thinking = content.iter().any(|block| {
			matches!(block, ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. })
		});
		let mut texts = content.iter().filter_map(|block| match block {
			ContentBlock::Text { text } => Some(text.as_str()),
			_ => None,
		});
		// A reply is almost always one text block, which is read in place.
		let prose: Cow<'_, str> = match (texts.next(), texts.next()) {
			(None, _) => Cow::Borrowed(""),
			(Some(only), None) => Cow::Borrowed(only),
			(Some(first), Some(second)) => {
				let mut joined = [first, second].concat();
				texts.for_each(|text| joined.push_str(text));
				Cow::Owned(joined)
			},
		};
		self.phase = match (&state.tool, prose.is_empty(), thinking) {
			(Some(tool), ..) => Phase::Tool(tool.clone()),
			(None, true, true) => Phase::Thinking,
			(None, ..) => Phase::Writing,
		};
		let current = self.doc.source();
		if current != prose {
			let delta = (!current.is_empty())
				.then(|| prose.strip_prefix(current))
				.flatten();
			match delta {
				Some(delta) => self.doc.append(delta),
				None => self.doc.set_source(prose.into_owned()),
			}
		}
		cx.notify();
	}

	/// Drops what the tail holds: its slot now draws the committed entry, or
	/// the list no longer has one.
	pub(super) fn release(&mut self, cx: &mut Context<Self>) {
		if self.phase == Phase::Idle && self.doc.source().is_empty() {
			return;
		}
		self.phase = Phase::Idle;
		self.doc.set_source(String::new());
		cx.notify();
	}
}

impl Render for StreamingTail {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let status = match &self.phase {
			Phase::Idle | Phase::Writing | Phase::Held => None,
			Phase::Thinking => Some("Thinking…".to_owned()),
			Phase::Tool(tool) => Some(format!("Running {tool}…")),
		};
		let prose = (self.phase != Phase::Idle && !self.doc.source().is_empty()).then(|| {
			let app = self.app.clone();
			let style = MarkdownStyle::new("streaming-tail")
				.on_link(move |url, _, cx| open_external(&app, url.to_string(), cx));
			markdown::render(&self.doc, &style, window, cx).into_any_element()
		});
		let column = div()
			.w_full()
			.max_w(size::COLUMN_MAX)
			.flex()
			.flex_col()
			.gap(space::S2)
			.children(prose)
			.children(status.map(|status| {
				div()
					.type_style(text::UI)
					.text_color(palette.text.muted)
					.child(status)
			}));
		// The padding an entry item draws, so the committed entry takes the
		// slot at the same place.
		div()
			.w_full()
			.flex()
			.justify_center()
			.when(self.phase != Phase::Idle, |d| d.px(space::S6).pt(space::S3))
			.child(column)
	}
}
