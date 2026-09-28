//! Drawing one planned transcript item.

use std::sync::Arc;

use gpui::{
	AnyElement, Context, ImageFormat, SharedString, Window, div, img, prelude::*, relative,
};
use veyyon_desktop_model::{ContentBlock, HostAction, SessionId, SurfaceId};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	markdown::{self, MarkdownDoc, MarkdownStyle},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};

use super::{
	Transcript,
	plan::{Opened, Piece, Plan, plan_entry},
	row::output_pane,
	tool::{open_external, render_view},
};
use crate::{actions::workspace::ShowPanelTab, driver};

/// The group an item's hover-only actions follow.
const ITEM_GROUP: &str = "transcript-item";

impl Transcript {
	/// Draws item `ix`. An entry that draws nothing (a result its call row
	/// shows) is an empty element, which the list measures at zero height.
	pub(super) fn render_entry(
		&mut self,
		ix: usize,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		self.item_renders += 1;
		let Some(session) = self.session.clone() else {
			return div().into_any_element();
		};
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
						let stale = self
							.docs
							.get(&key)
							.is_none_or(|(revision, _)| *revision != plan.revision);
						if stale && let Some(ContentBlock::Text { text }) = entry.content.get(*block) {
							self.parses += 1;
							self
								.docs
								.insert(key, (plan.revision, MarkdownDoc::new(text.clone())));
						}
					},
					Piece::Image { block, .. } => {
						let key = (plan.id.clone(), *block);
						if !self.images.contains_key(&key)
							&& let Some((format, data)) = entry.content.get(*block).and_then(image_bytes)
						{
							self
								.images
								.insert(key, Arc::new(gpui::Image::from_bytes(format, data.to_vec())));
						}
					},
					_ => {},
				}
			}
		}
		let last_turn = self.turns.is_last(ix);
		let turn_start = self
			.turns
			.turn_at(ix)
			.is_some_and(|turn| turn.range.start == ix);
		let item_end = self
			.turns
			.turn_at(ix)
			.is_some_and(|turn| turn.range.end == ix + 1);
		let palette = cx.theme().palette;
		let pieces: Vec<AnyElement> = plan
			.pieces
			.iter()
			.enumerate()
			.map(|(piece_ix, piece)| {
				self.render_piece(ix, &plan, piece_ix, piece, &session, &palette, window, cx)
			})
			.collect();
		let actions =
			self.item_actions(ix, &plan, &session, last_turn && item_end && !self.working, &palette);
		// Group names resolve to the innermost painting ancestor, so one name
		// serves every item without formatting a name per render.
		let group = SharedString::new_static(ITEM_GROUP);
		let column = div()
			.w_full()
			.max_w(size::COLUMN_MAX)
			.flex()
			.flex_col()
			.gap(space::S2)
			.when(plan.operator, |d| d.items_end())
			.children(pieces)
			.child(
				div()
					.invisible()
					.group_hover(group.clone(), |s| s.visible())
					.child(actions),
			);
		let item = div()
			.group(group)
			.w_full()
			.flex()
			.justify_center()
			.px(space::S6)
			.pt(if turn_start && ix > 0 {
				space::S6
			} else {
				space::S3
			})
			.child(column);
		driver::target(("transcript.entry", plan.id.0.as_str()), item)
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
				.when(*boundary, |d| {
					d.border_t_1()
						.border_color(palette.border.subtle)
						.pt(space::S2)
				})
				.child(div().text_color(palette.text.muted).child(label.clone()))
				.child(
					div()
						.text_color(palette.text.secondary)
						.child(words.clone()),
				)
				.into_any_element(),
			Piece::Thinking { block, text: body, redacted } => {
				let this = Self::weak(cx);
				let key = (plan.id.clone(), *block);
				let label = if *redacted {
					"Thought (redacted)"
				} else {
					"Thought"
				};
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
									this
										.update(cx, |this, cx| this.toggle_thought(ix, key.clone(), cx))
										.ok();
								})
							}),
					)
					.children(body.clone().map(|body| {
						div()
							.pl(space::S4)
							.type_style(text::UI)
							.text_color(palette.text.muted)
							.child(body)
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
						this
							.update(cx, |this, cx| this.toggle_turn(anchor, cx))
							.ok();
					})
					.into_any_element()
			},
			Piece::Pane { caption, lines, diff } => div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.child(
					div()
						.type_style(text::SMALL)
						.text_color(palette.text.muted)
						.child(caption.clone()),
				)
				.child(output_pane(&id, lines, *diff, palette))
				.into_any_element(),
			Piece::Report { variant, view } => div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.child(
					div()
						.type_style(text::SMALL)
						.text_color(palette.text.muted)
						.child(variant.replace(['_', '-'], " ")),
				)
				.child(render_view(view, &id, &self.app, cx))
				.into_any_element(),
			// An image whose bytes do not decode draws the words it was sent
			// with, as one in a format the window does not read does.
			Piece::Image { block, alt } => {
				let words = alt.clone().unwrap_or_else(|| "Image".to_owned());
				let caption = move |palette: &Palette| {
					div()
						.type_style(text::SMALL)
						.text_color(palette.text.muted)
						.child(words.clone())
						.into_any_element()
				};
				match self.images.get(&(plan.id.clone(), *block)) {
					Some(image) => {
						let palette = *palette;
						img(Arc::clone(image))
							.max_h(size::MEDIA_MAX)
							.rounded(radius::LG)
							.with_fallback(move || caption(&palette))
							.into_any_element()
					},
					None => caption(palette),
				}
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
					.child(
						div()
							.text_color(palette.status.error)
							.child(message.clone()),
					)
					.child(
						IconButton::new(SharedString::from(id), IconName::RefreshCw)
							.tooltip("Retry")
							.on_click(move |_, _, cx| {
								let session = session.clone();
								app.update(cx, |app, cx| {
									app.dispatch(
										HostAction::RetryTurn { session: session.clone() },
										SurfaceId::SessionRetryButton(session),
										cx,
									);
								});
							}),
					)
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
}

/// The format and bytes of the picture `block` carries: an attached image,
/// or the picture of a file the prompt named, read by the file's extension.
fn image_bytes(block: &ContentBlock) -> Option<(ImageFormat, &[u8])> {
	match block {
		ContentBlock::Image { media_type, data, .. } => {
			ImageFormat::from_mime_type(media_type).map(|format| (format, data.as_slice()))
		},
		ContentBlock::FileMention { path, image: Some(data), .. } => {
			let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
			let format = match extension.as_str() {
				"png" => ImageFormat::Png,
				"jpg" | "jpeg" => ImageFormat::Jpeg,
				"gif" => ImageFormat::Gif,
				"webp" => ImageFormat::Webp,
				"svg" => ImageFormat::Svg,
				"bmp" => ImageFormat::Bmp,
				"tif" | "tiff" => ImageFormat::Tiff,
				_ => return None,
			};
			Some((format, data.as_slice()))
		},
		_ => None,
	}
}
