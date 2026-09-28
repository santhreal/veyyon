//! Drawing the diff tab: each row of the list, under the toolbar.

use std::sync::Arc;

use veyyon_desktop_model::{
	Capability, CapabilityStatus, ChangeScope, ChangeStatus, HostActionKind,
};
use veyyon_desktop_ui::{
	controls::{Button, IconButton},
	icons::IconName,
	markdown::Highlighted,
	theme::{ActiveTheme, Palette, TypeStyled, space, text},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, HighlightStyle, Hsla, IntoElement, ParentElement, Render,
	SharedString, Stateful, Styled, StyledText, Window, combine_highlights, div, list, prelude::*,
};

use super::{
	DiffView,
	parse::LineKind,
	review::{line_anchor, needs_attention},
	rows::Row,
	words::Emphasis,
};
use crate::{
	actions::panel::OpenFile,
	panel::style::{code_line, counted, empty_state, spans_in},
};

/// The letter and color a file's status is drawn with.
const fn status_mark(status: Option<ChangeStatus>, palette: &Palette) -> (&'static str, Hsla) {
	match status {
		Some(ChangeStatus::Added) => ("A", palette.status.success),
		Some(ChangeStatus::Modified) | None => ("M", palette.status.waiting),
		Some(ChangeStatus::Deleted) => ("D", palette.status.error),
		Some(ChangeStatus::Renamed) => ("R", palette.status.info),
		Some(ChangeStatus::Untracked) => ("U", palette.status.success),
		Some(ChangeStatus::Conflicted) => ("C", palette.status.error),
	}
}

impl DiffView {
	fn render_row(&mut self, ix: usize, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let Some(&row) = self.layout.rows.get(ix) else {
			return div().into_any_element();
		};
		let element = match row {
			Row::File(file) => div().child(self.file_header(file, &palette, cx)),
			Row::Line { file, line } => self.line_row(file, Some(line), 2, true, &palette, cx),
			Row::Pair { file, left, right } if left == right => {
				self.line_row(file, left, 2, false, &palette, cx)
			},
			Row::Pair { file, left, right } => div()
				.flex()
				.child(self.line_row(file, left, 1, false, &palette, cx).w_1_2())
				.child(
					self
						.line_row(file, right, 1, false, &palette, cx)
						.w_1_2()
						.border_l_1()
						.border_color(palette.border.subtle),
				),
			Row::Thread { file, thread } => self.thread_row(file, thread, &palette, cx),
			Row::Draft { .. } => self.draft_row(&palette, cx),
			Row::NoText(file) => {
				let binary = self.parsed.files.get(file).is_some_and(|file| file.binary);
				notice(
					if binary {
						"Binary file"
					} else {
						"No diff text for this file"
					},
					&palette,
				)
			},
			Row::Truncated => notice(&self.truncated_copy(), &palette),
		};
		// A row laid out as a flex row shrinks to its content unless it is
		// given the list's width, and a line then never wraps.
		element.id(("diff-row", ix)).w_full().into_any_element()
	}

	fn truncated_copy(&self) -> String {
		let mut copy = String::new();
		if self.parsed.truncated {
			copy.push_str("The diff stops at the host's size limit.");
		}
		if self.parsed.withheld > 0 {
			if !copy.is_empty() {
				copy.push(' ');
			}
			copy.push_str(&counted(self.parsed.withheld, "more file", "more files"));
			copy.push_str(" not shown.");
		}
		copy
	}

	fn file_header(&self, file: usize, palette: &Palette, cx: &Context<Self>) -> Stateful<Div> {
		let Some(diff_file) = self.parsed.files.get(file) else {
			return div().id(("diff-file", file));
		};
		let path = diff_file.path.clone();
		let collapsed = self.collapsed.contains(&path);
		let (letter, color) = status_mark(diff_file.status, palette);
		let label = match &diff_file.previous_path {
			Some(previous) => format!("{previous} \u{2192} {path}"),
			None => path.clone(),
		};
		let open_threads = self
			.placements
			.at
			.iter()
			.filter(|((f, _), _)| *f == file)
			.flat_map(|(_, threads)| threads)
			.chain(self.placements.outdated.get(&file).into_iter().flatten())
			.filter(|id| {
				self
					.app
					.read(cx)
					.reviews()
					.threads
					.iter()
					.any(|t| t.id == **id && needs_attention(t))
			})
			.count();
		let toggle_path = path.clone();
		div()
			.id(("diff-file", file))
			.flex()
			.items_center()
			.gap(space::S2)
			.px(space::S2)
			.py(space::S1)
			.bg(palette.bg.surface)
			.border_b_1()
			.border_color(palette.border.subtle)
			.type_style(text::UI)
			.cursor_pointer()
			.on_click(
				cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_file(&toggle_path, cx)),
			)
			.child(
				veyyon_desktop_ui::icons::Icon::new(if collapsed {
					IconName::ChevronRight
				} else {
					IconName::ChevronDown
				})
				.color(palette.text.muted),
			)
			.child(
				div()
					.type_style(text::MICRO)
					.text_color(color)
					.child(letter),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.text_color(palette.text.primary)
					.child(label),
			)
			.children((open_threads > 0).then(|| {
				div()
					.type_style(text::MICRO)
					.text_color(palette.text.secondary)
					.child(counted(open_threads as u64, "comment", "comments"))
			}))
			.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.diff.add_fg)
					.child(format!("+{}", diff_file.additions)),
			)
			.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.diff.del_fg)
					.child(format!("\u{2212}{}", diff_file.deletions)),
			)
			.child(
				IconButton::new(("diff-open", file), IconName::FileText)
					.tooltip("Open file")
					.on_click(move |_: &ClickEvent, window, cx| {
						cx.stop_propagation();
						window.dispatch_action(Box::new(OpenFile { path: path.clone(), line: None }), cx);
					}),
			)
	}

	/// One line of a file: its gutter of `numbers` line numbers, its sign
	/// when `signed`, and its text; an empty half of a split pair when
	/// `line` is `None`.
	fn line_row(
		&mut self,
		file: usize,
		line: Option<usize>,
		numbers: usize,
		signed: bool,
		palette: &Palette,
		cx: &Context<Self>,
	) -> Div {
		let row = div()
			.flex()
			.min_h(text::MONO.line_height)
			.type_style(text::MONO);
		let Some(diff_line) =
			line.and_then(|line| self.parsed.files.get(file)?.lines.get(line).cloned())
		else {
			return row.bg(palette.bg.hover);
		};
		let line = line.unwrap_or_default();
		let text = self
			.parsed
			.source
			.get(diff_line.text.clone())
			.unwrap_or_default();
		let text = SharedString::from(text.to_owned());
		if matches!(diff_line.kind, LineKind::Hunk | LineKind::Note) {
			return row
				.px(space::S2)
				.bg(palette.bg.surface)
				.text_color(palette.text.muted)
				.child(div().truncate().child(text));
		}
		let side = diff_line.side();
		if let Some(side) = side {
			self.ensure_highlight(file, side, cx);
		}
		let highlighted = side
			.and_then(|side| self.highlights.get(&(file, side)))
			.cloned();
		if matches!(diff_line.kind, LineKind::Added | LineKind::Removed) {
			self.ensure_words(file, cx);
		}
		let (bg, sign, ink) = match diff_line.kind {
			LineKind::Added => (Some(palette.diff.add_bg), "+", palette.diff.add_fg),
			LineKind::Removed => (Some(palette.diff.del_bg), "\u{2212}", palette.diff.del_fg),
			_ => (None, " ", palette.text.faint),
		};
		let numbers: Vec<Option<u32>> = match numbers {
			2 => vec![diff_line.old, diff_line.new],
			_ => vec![if diff_line.kind == LineKind::Removed {
				diff_line.old
			} else {
				diff_line.new
			}],
		};
		let commentable = self.scope.is_some() && line_anchor(&diff_line).is_some();
		let gutter = div()
			.id(("diff-gutter", line))
			.flex()
			.flex_none()
			.text_color(palette.text.faint)
			.children(numbers.into_iter().map(|number| {
				div()
					.w(space::S10)
					.pr(space::S1)
					.flex()
					.justify_end()
					.child(number.map(|n| n.to_string()).unwrap_or_default())
			}))
			.when(commentable, |gutter| {
				gutter
					.cursor_pointer()
					.hover(|style| style.text_color(palette.accent.base))
					.on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
						cx.stop_propagation();
						this.start_draft(file, line, None, window, cx);
					}))
			});
		let emphasis = bg.and_then(|tint| {
			let words = self.words.get(&file)?.as_ref()?;
			Some((&**words, line, tint))
		});
		row.when_some(bg, |row, bg| row.bg(bg))
			.child(gutter)
			.when(signed, |row| row.child(div().w(space::S3).flex_none().text_color(ink).child(sign)))
			.child(
				div()
					.flex_1()
					.min_w_0()
					.pl(space::S1)
					.when(!self.wrap, |code| code.overflow_hidden().whitespace_nowrap())
					.text_color(palette.text.primary)
					.child(diff_text(text, highlighted.as_ref(), diff_line.at, emphasis, palette)),
			)
	}
}

/// A diff line's `text`, colored by `highlighted` once its spans arrived,
/// with the words `emphasis` marks for its line tinted a second time with
/// the line's own tint.
fn diff_text(
	text: SharedString,
	highlighted: Option<&Arc<Highlighted>>,
	at: usize,
	emphasis: Option<(&Emphasis, usize, Hsla)>,
	palette: &Palette,
) -> StyledText {
	let Some((emphasis, line, tint)) = emphasis else {
		return code_line(text, highlighted, at, palette);
	};
	let syntax = highlighted
		.map(|highlighted| spans_in(highlighted, at..at + text.len(), palette))
		.unwrap_or_default();
	let words = emphasis.of_line(line).map(|range| {
		(range, HighlightStyle { background_color: Some(tint), ..HighlightStyle::default() })
	});
	StyledText::new(text).with_highlights(combine_highlights(syntax, words))
}

fn notice(copy: &str, palette: &Palette) -> Div {
	div()
		.px(space::S3)
		.py(space::S2)
		.type_style(text::SMALL)
		.text_color(palette.text.muted)
		.child(SharedString::from(copy.to_owned()))
}

impl Render for DiffView {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let (answered, refused, pending_edits) = {
			let app = self.app.read(cx);
			let pending_edits = match app.store().capabilities.get(Capability::PendingEdits) {
				CapabilityStatus::Unavailable { reason } => Some(reason.clone()),
				CapabilityStatus::Available | CapabilityStatus::UnknownUntilAttached => None,
			};
			(
				app.store().domains.changes.is_some(),
				app.panel_unavailable(HostActionKind::RefreshChanges),
				pending_edits,
			)
		};
		let body = if let Some(reason) = refused {
			// A host that reads no repository states why in place of the diff.
			empty_state(reason, None::<Div>, &palette).into_any_element()
		} else if !answered {
			empty_state(
				"Changes have not loaded",
				Some(
					Button::new("diff-load", "Load changes")
						.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.refresh(cx))),
				),
				&palette,
			)
			.into_any_element()
		} else if self.parsed.files.is_empty() {
			let copy = match self.change_scope {
				ChangeScope::WorkingTree => "No changes in the working tree",
				ChangeScope::Staged => "Nothing is staged",
			};
			empty_state(copy, None::<Div>, &palette).into_any_element()
		} else {
			list(self.list.clone(), cx.processor(|this, ix, _, cx| this.render_row(ix, cx)))
				.flex_1()
				.size_full()
				.into_any_element()
		};
		div()
			.flex()
			.flex_col()
			.size_full()
			.child(self.render_toolbar(&palette, cx))
			// A host that keeps no edit buffer states why above the changes it
			// still reads.
			.children(pending_edits.map(|reason| notice(&reason, &palette)))
			.child(div().flex().flex_col().flex_1().min_h_0().child(body))
	}
}
