//! Drawing one planned transcript item.

use std::sync::Arc;

use gpui::{AnyElement, ClipboardItem, Context, Hsla, ImageFormat, SharedString, Window, div, img, prelude::*, relative};
use veyyon_desktop_model::{ContentBlock, EntryId, HostAction, SessionId, SurfaceId, tool_view::ViewStatus};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	markdown::{self, MarkdownDoc, MarkdownStyle},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};

use super::{
	Transcript,
	plan::{Opened, Piece, Plan, ToolBody, ToolRow, copy_text, plan_entry},
	tool::{open_external, render_view, status_mark},
	turn::duration_words,
};
use crate::{actions::workspace::ShowPanelTab, driver};

impl Transcript {
	/// Draws item `ix`. An entry that draws nothing (a result its call row
	/// shows) is an empty element, which the list measures at zero height.
	pub(super) fn render_entry(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
		let Some(session) = self.session.clone() else { return div().into_any_element() };
		let app = self.app.read(cx);
		let opened = Opened {
			tools:    &self.tools,
			thoughts: &self.thoughts,
			turns:    &self.turns_open,
			working:  self.working,
		};
		let Some(plan) = plan_entry(app, &session, ix, &self.turns, &opened) else {
			return div().into_any_element();
		};
		if plan.pieces.is_empty() {
			return div().into_any_element();
		}
		if let Some(entry) = app.entry_at(&session, ix) {
			for piece in &plan.pieces {
				match piece {
					Piece::Prose { block } => {
						let key = (plan.id.clone(), *block);
						let stale = self.docs.get(&key).is_none_or(|(revision, _)| *revision != plan.revision);
						if stale && let Some(ContentBlock::Text { text }) = entry.content.get(*block) {
							self.docs.insert(key, (plan.revision, MarkdownDoc::new(text.clone())));
						}
					},
					Piece::Image { block, .. } => {
						let key = (plan.id.clone(), *block);
						if !self.images.contains_key(&key)
							&& let Some(ContentBlock::Image { media_type, data, .. }) = entry.content.get(*block)
							&& let Some(format) = image_format(media_type)
						{
							self.images.insert(key, Arc::new(gpui::Image::from_bytes(format, data.clone())));
						}
					},
					_ => {},
				}
			}
		}
		let last_turn = self.turns.is_last(ix);
		let turn_start = self.turns.turn_at(ix).is_some_and(|turn| turn.range.start == ix);
		let item_end = self.turns.turn_at(ix).is_some_and(|turn| turn.range.end == ix + 1);
		let palette = cx.theme().palette;
		let pieces: Vec<AnyElement> = plan
			.pieces
			.iter()
			.enumerate()
			.map(|(piece_ix, piece)| self.render_piece(ix, &plan, piece_ix, piece, &session, &palette, window, cx))
			.collect();
		let actions = self.item_actions(ix, &plan, &session, last_turn && item_end && !self.working, &palette, cx);
		let group = SharedString::from(format!("transcript-item-{ix}"));
		let column = div()
			.w_full()
			.max_w(size::COLUMN_MAX)
			.flex()
			.flex_col()
			.gap(space::S2)
			.when(plan.operator, |d| d.items_end())
			.children(pieces)
			.child(div().invisible().group_hover(group.clone(), |s| s.visible()).child(actions));
		let item = div()
			.group(group)
			.w_full()
			.flex()
			.justify_center()
			.px(space::S6)
			.pt(if turn_start && ix > 0 { space::S6 } else { space::S3 })
			.child(column);
		driver::target(format!("transcript.entry:{}", plan.id.0), item)
	}

	#[expect(clippy::too_many_arguments, reason = "the drawing inputs of one piece")]
	fn render_piece(
		&self,
		ix: usize,
		plan: &Plan,
		piece_ix: usize,
		piece: &Piece,
		session: &SessionId,
		palette: &Palette,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let id = format!("t{ix}-{piece_ix}");
		match piece {
			Piece::Bubble(words) => div()
				.max_w(relative(0.8))
				.px(space::S3_5)
				.py(space::S2_5)
				.rounded(radius::XL)
				.bg(palette.bg.surface)
				.type_style(text::BODY)
				.text_color(palette.text.primary)
				.child(words.clone())
				.into_any_element(),
			Piece::Prose { block } => match self.docs.get(&(plan.id.clone(), *block)) {
				Some((_, doc)) => {
					let app = self.app.clone();
					let style = MarkdownStyle::new(SharedString::from(id))
						.on_link(move |url, _, cx| open_external(&app, url.to_string(), cx));
					markdown::render(doc, &style, window, cx).into_any_element()
				},
				None => div().into_any_element(),
			},
			Piece::Note { label, text: words, boundary } => div()
				.flex()
				.gap(space::S2)
				.type_style(text::SMALL)
				.when(*boundary, |d| d.border_t_1().border_color(palette.border.subtle).pt(space::S2))
				.child(div().text_color(palette.text.muted).child(label.clone()))
				.child(div().text_color(palette.text.secondary).child(words.clone()))
				.into_any_element(),
			Piece::Thinking { block, text: body, redacted } => {
				let this = Self::weak(cx);
				let key = (plan.id.clone(), *block);
				let label = if *redacted { "Thought (redacted)" } else { "Thought" };
				div()
					.flex()
					.flex_col()
					.gap(space::S1)
					.child(
						div()
							.id(SharedString::from(id))
							.type_style(text::UI)
							.text_color(palette.text.muted)
							.cursor_pointer()
							.child(format!("{} {label}", if body.is_some() { "▾" } else { "▸" }))
							.when(!*redacted, |d| {
								d.on_click(move |_, _, cx| {
									this.update(cx, |this, cx| this.toggle_thought(ix, key.clone(), cx)).ok();
								})
							}),
					)
					.children(body.clone().map(|body| {
						div().pl(space::S4).type_style(text::UI).text_color(palette.text.muted).child(body)
					}))
					.into_any_element()
			},
			Piece::Tool(row) => self.tool_row(ix, row, &id, session, palette, cx),
			Piece::Worked { anchor, text: words, open } => {
				let this = Self::weak(cx);
				let anchor = *anchor;
				div()
					.id(SharedString::from(id))
					.type_style(text::UI)
					.text_color(palette.text.muted)
					.cursor_pointer()
					.child(format!("{} {words}", if *open { "▾" } else { "▸" }))
					.on_click(move |_, _, cx| {
						this.update(cx, |this, cx| this.toggle_turn(anchor, cx)).ok();
					})
					.into_any_element()
			},
			Piece::Pane { caption, lines, diff } => div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.child(div().type_style(text::SMALL).text_color(palette.text.muted).child(caption.clone()))
				.child(output_pane(&id, lines, *diff, palette))
				.into_any_element(),
			Piece::Report { variant, view } => div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.child(
					div().type_style(text::SMALL).text_color(palette.text.muted).child(variant.replace(['_', '-'], " ")),
				)
				.child(render_view(view, &id, &self.app, cx))
				.into_any_element(),
			Piece::Image { block, alt } => match self.images.get(&(plan.id.clone(), *block)) {
				Some(image) => img(Arc::clone(image)).max_h(size::MEDIA_MAX).rounded(radius::LG).into_any_element(),
				None => div()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(alt.clone().unwrap_or_else(|| "Image".to_owned()))
					.into_any_element(),
			},
			Piece::File { path, detail } => {
				let app = self.app.clone();
				let target = path.clone();
				div()
					.id(SharedString::from(id))
					.flex()
					.gap(space::S2)
					.px(space::S2)
					.py(space::S1)
					.rounded(radius::MD)
					.border_1()
					.border_color(palette.border.subtle)
					.type_style(text::SMALL)
					.cursor_pointer()
					.child(div().text_color(palette.text.primary).child(path.clone()))
					.child(div().text_color(palette.text.muted).child(detail.clone()))
					.on_click(move |_, _, cx| open_external(&app, target.clone(), cx))
					.into_any_element()
			},
			Piece::Error(message) => {
				let app = self.app.clone();
				let session = session.clone();
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.type_style(text::UI)
					.child(div().text_color(palette.status.error).child(message.clone()))
					.child(IconButton::new(SharedString::from(id), IconName::RefreshCw).tooltip("Retry").on_click(
						move |_, _, cx| {
							let session = session.clone();
							app.update(cx, |app, cx| {
								app.dispatch(
									HostAction::RetryTurn { session: session.clone() },
									SurfaceId::SessionRetryButton(session),
									cx,
								);
							});
						},
					))
					.into_any_element()
			},
			Piece::Footer(model) => div()
				.id(SharedString::from(id))
				.type_style(text::MICRO)
				.text_color(palette.text.faint)
				.cursor_pointer()
				.child(model.clone())
				.on_click(|_, window, cx| {
					window.dispatch_action(Box::new(ShowPanelTab { tab: "usage".into() }), cx);
				})
				.into_any_element(),
		}
	}

	fn tool_row(
		&self,
		ix: usize,
		row: &ToolRow,
		id: &str,
		session: &SessionId,
		palette: &Palette,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let (glyph, color) = status_mark(row.status, palette);
		let this = Self::weak(cx);
		let (call_id, open) = (row.call_id.clone(), !row.open);
		let cancel = (row.status == ViewStatus::Running).then(|| {
			let app = self.app.clone();
			let (session, tool_call_id) = (session.clone(), row.call_id.clone());
			IconButton::new(SharedString::from(format!("{id}-cancel")), IconName::Square).tooltip("Cancel").on_click(
				move |_, _, cx| {
					let (session, tool_call_id) = (session.clone(), tool_call_id.clone());
					app.update(cx, |app, cx| {
						let surface = SurfaceId::ComposerCancelToolButton(session.clone(), tool_call_id.clone());
						app.dispatch(HostAction::CancelTool { session, tool_call_id }, surface, cx);
					});
				},
			)
		});
		let header = div()
			.id(SharedString::from(id.to_owned()))
			.flex()
			.items_center()
			.gap(space::S2)
			.type_style(text::UI)
			.cursor_pointer()
			.child(div().text_color(color).child(glyph))
			.child(div().text_color(palette.text.primary).child(row.verb.clone()))
			.children(
				row.target.clone().map(|target| div().flex_1().min_w_0().truncate().text_color(palette.text.muted).child(target)),
			)
			.children(row.duration_ms.map(|ms| {
				div().type_style(text::SMALL).text_color(palette.text.faint).child(duration_words(ms / 1000))
			}))
			.children(cancel)
			.on_click(move |_, _, cx| {
				this.update(cx, |this, cx| this.toggle_tool(ix, call_id.clone(), open, cx)).ok();
			});
		let body = row.body.as_ref().map(|body| match body {
			ToolBody::View(presentation) => div()
				.pl(space::S5)
				.child(render_view(&presentation.view, id, &self.app, cx))
				.into_any_element(),
			ToolBody::Lines(lines) => div().pl(space::S5).child(output_pane(id, lines, false, palette)).into_any_element(),
		});
		div().flex().flex_col().gap(space::S1).child(header).children(body).into_any_element()
	}

	fn item_actions(
		&self,
		ix: usize,
		plan: &Plan,
		session: &SessionId,
		last: bool,
		palette: &Palette,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let copy = {
			let app = self.app.clone();
			let session = session.clone();
			IconButton::new(SharedString::from(format!("t{ix}-copy")), IconName::Copy).tooltip("Copy").on_click(
				move |_, _, cx| {
					let words = app.read(cx).entry_at(&session, ix).map(copy_text).unwrap_or_default();
					cx.write_to_clipboard(ClipboardItem::new_string(words));
				},
			)
		};
		let branch = self.session_button(
			format!("t{ix}-branch"),
			IconName::GitFork,
			"Branch from here",
			session,
			Some(plan.id.clone()),
			Action::Branch,
		);
		let turn_actions = last.then(|| {
			[
				self.session_button(format!("t{ix}-retry"), IconName::RefreshCw, "Retry", session, None, Action::Retry),
				self.session_button(format!("t{ix}-rephrase"), IconName::Pencil, "Rephrase", session, None, Action::Rephrase),
			]
		});
		let _ = cx;
		div()
			.flex()
			.gap(space::S1)
			.text_color(palette.text.muted)
			.when(plan.operator, |d| d.justify_end())
			.child(copy)
			.child(branch)
			.children(turn_actions.into_iter().flatten())
			.into_any_element()
	}

	fn session_button(
		&self,
		id: String,
		icon: IconName,
		label: &'static str,
		session: &SessionId,
		entry: Option<EntryId>,
		action: Action,
	) -> IconButton {
		let app = self.app.clone();
		let session = session.clone();
		IconButton::new(SharedString::from(id), icon).tooltip(label).on_click(move |_, _, cx| {
			let (session, entry) = (session.clone(), entry.clone());
			app.update(cx, |app, cx| {
				let (host, surface) = match action {
					Action::Branch => (
						HostAction::BranchSession { session: session.clone(), entry },
						SurfaceId::SessionBranchButton(session),
					),
					Action::Retry => {
						(HostAction::RetryTurn { session: session.clone() }, SurfaceId::SessionRetryButton(session))
					},
					Action::Rephrase => (
						HostAction::RephraseReply { session: session.clone() },
						SurfaceId::SessionRephraseButton(session),
					),
				};
				app.dispatch(host, surface, cx);
			});
		})
	}
}

/// The session-level actions an item's hover row sends.
#[derive(Clone, Copy)]
enum Action {
	Branch,
	Retry,
	Rephrase,
}

/// Output lines in a mono pane at most `TOOL_OUTPUT_MAX` tall, scrolling
/// past that. A diff colors each line by its first character.
fn output_pane(id: &str, lines: &[String], diff: bool, palette: &Palette) -> AnyElement {
	div()
		.id(SharedString::from(format!("{id}-out")))
		.max_h(size::TOOL_OUTPUT_MAX)
		.overflow_y_scroll()
		.p(space::S2)
		.rounded(radius::MD)
		.bg(palette.code.bg)
		.type_style(text::MONO)
		.text_color(palette.text.secondary)
		.children(lines.iter().map(|line| {
			let color: Option<Hsla> = if diff {
				match line.chars().next() {
					Some('+') => Some(palette.diff.add_fg),
					Some('-') => Some(palette.diff.del_fg),
					_ => None,
				}
			} else {
				None
			};
			div().whitespace_nowrap().when_some(color, |d, color| d.text_color(color)).child(line.clone())
		}))
		.into_any_element()
}

fn image_format(media_type: &str) -> Option<ImageFormat> {
	match media_type {
		"image/png" => Some(ImageFormat::Png),
		"image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
		"image/gif" => Some(ImageFormat::Gif),
		"image/webp" => Some(ImageFormat::Webp),
		"image/svg+xml" => Some(ImageFormat::Svg),
		"image/bmp" => Some(ImageFormat::Bmp),
		"image/tiff" => Some(ImageFormat::Tiff),
		_ => None,
	}
}
