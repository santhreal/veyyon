//! The streaming tail: the reply the agent is writing, drawn under the
//! transcript list as its own entity.
//!
//! A delta notifies this entity and nothing else, and only the markdown block
//! still growing is reparsed (`MarkdownDoc::append`). When the reply is
//! committed the store splices it into the list and the tail empties.

use gpui::{Context, Entity, Render, Subscription, Window, div, prelude::*};
use veyyon_desktop_model::{ContentBlock, SessionId};
use veyyon_desktop_ui::{
	markdown::{self, MarkdownDoc, MarkdownStyle},
	theme::{ActiveTheme, TypeStyled, size, space, text},
};

use crate::{AppState, StoreEvent, transcript::tool::open_external};

/// What the tail shows.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
	/// Nothing is streaming.
	Idle,
	/// The model is thinking and has written no prose yet.
	Thinking,
	/// A tool is running.
	Tool(String),
	/// Prose is arriving.
	Writing,
}

/// The streaming tail region.
pub struct StreamingTail {
	app:           Entity<AppState>,
	session:       Option<SessionId>,
	doc:           MarkdownDoc,
	phase:         Phase,
	renders:       usize,
	_subscription: Subscription,
}

impl StreamingTail {
	/// Creates the tail over `app`'s active session.
	pub fn new(app: Entity<AppState>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
			StoreEvent::ActiveSessionChanged => this.sync(cx),
			StoreEvent::StreamingChanged { session } if this.session.as_ref() == Some(session) => {
				this.sync(cx);
			},
			_ => {},
		});
		let mut this = Self {
			app,
			session: None,
			doc: MarkdownDoc::default(),
			phase: Phase::Idle,
			renders: 0,
			_subscription: subscription,
		};
		this.sync(cx);
		this
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

	fn sync(&mut self, cx: &mut Context<Self>) {
		let app = self.app.read(cx);
		self.session = app.active_session().cloned();
		let streaming = self.session.as_ref().and_then(|session| app.streaming(session));
		let (phase, prose) = match streaming {
			None => (Phase::Idle, String::new()),
			Some(state) => {
				let mut prose = String::new();
				let mut thinking = false;
				for block in &state.accumulating.content {
					match block {
						ContentBlock::Text { text } => prose.push_str(text),
						ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. } => thinking = true,
						_ => {},
					}
				}
				let phase = match (&state.tool, prose.is_empty(), thinking) {
					(Some(tool), _, _) => Phase::Tool(tool.clone()),
					(None, false, _) => Phase::Writing,
					(None, true, true) => Phase::Thinking,
					(None, true, false) => Phase::Writing,
				};
				(phase, prose)
			},
		};
		let current = self.doc.source();
		if current != prose {
			let delta =
				if current.is_empty() { None } else { prose.strip_prefix(current).map(str::to_owned) };
			match delta {
				Some(delta) => self.doc.append(&delta),
				None => self.doc.set_source(prose),
			}
		}
		self.phase = phase;
		cx.notify();
	}
}

impl Render for StreamingTail {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let status = match &self.phase {
			Phase::Idle | Phase::Writing => None,
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
			.children(status.map(|status| div().type_style(text::UI).text_color(palette.text.muted).child(status)));
		div()
			.w_full()
			.flex()
			.justify_center()
			.when(self.phase != Phase::Idle, |d| d.px(space::S6).pb(space::S3))
			.child(column)
	}
}
