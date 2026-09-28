//! How the sheet draws: the filters over the rows, the step the sheet is in,
//! and one status line under them.
//!
//! The rows are a [`uniform_list`] of [`ListRow`]s, so a frame lays out only
//! the rows scrolled into view whatever the size of the tree. Each row is
//! indented by the host's depth, leads with a mark for the path to the leaf
//! and the role marker in its kind's tone, and ends with its label.

use std::ops::Range;

use gpui::{
	AnyElement, ClickEvent, Context, CursorStyle, Hsla, IntoElement, Render, SharedString, Window,
	div, prelude::*, uniform_list,
};
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{EntryId, SessionTreeEntryKind, SessionTreeFilter, SessionTreeNode};
use veyyon_desktop_ui::{
	controls::{IconButton, ListRow, hover_transition},
	icons::IconName,
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};

use super::{SessionTreeSheet, SheetEvent, Status, Step, steps::SUMMARY_CHOICES};
use crate::driver;

impl Render for SessionTreeSheet {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let body = match &self.step {
			Step::Browse => self.list(&palette, cx),
			Step::Summary { cursor, .. } => Self::summary(*cursor, &palette, cx),
			Step::Instructions { .. } => self.field("Custom summarization instructions", &palette),
			Step::Label { .. } => self.field("Label for this entry", &palette),
		};
		div()
			.id("session-tree")
			.key_context("SessionTree")
			.track_focus(&self.focus)
			.on_key_down(cx.listener(Self::on_key_down))
			.flex()
			.flex_col()
			.size_full()
			.min_h_0()
			.bg(palette.bg.app)
			.child(self.header(&palette, cx))
			.child(body)
			.child(self.status_line(&palette))
	}
}

impl SessionTreeSheet {
	/// The title, a chip per filter that picks it, and the close button.
	fn header(&self, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let current = self.current_filter(cx);
		let chips = SessionTreeFilter::iter().map(|filter| {
			let on = filter == current;
			div()
				.id(("tree-filter", filter as usize))
				.px(space::S2)
				.py(space::S1)
				.rounded(radius::MD)
				.type_style(text::SMALL)
				.cursor(CursorStyle::PointingHand)
				.transition(hover_transition())
				.when(on, |chip| {
					chip
						.bg(palette.bg.selected)
						.text_color(palette.text.primary)
				})
				.when(!on, |chip| {
					let hover = palette.bg.hover;
					let primary = palette.text.primary;
					chip
						.text_color(palette.text.muted)
						.hover(move |style| style.bg(hover).text_color(primary))
				})
				.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.pick_filter(filter, cx)))
				.child(filter_label(filter))
		});
		let close = IconButton::new("tree-close", IconName::X)
			.tooltip("Close")
			.on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(SheetEvent::Closed)));
		div()
			.flex()
			.flex_none()
			.items_center()
			.gap(space::S2)
			.h(size::HEADER)
			.px(space::S3)
			.border_b_1()
			.border_color(palette.border.subtle)
			.child(
				div()
					.type_style(text::UI)
					.text_color(palette.text.primary)
					.child("Session tree"),
			)
			.child(div().flex().gap(space::S1).children(chips))
			.child(div().flex_1())
			.child(driver::target("tree.close", close))
			.into_any_element()
	}

	/// The rows the filter shows, or why there are none.
	fn list(&self, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		if self.tree(cx).is_none() {
			return note("Loading the session tree…", palette);
		}
		if self.shown.is_empty() {
			return note("No entry matches this filter", palette);
		}
		uniform_list(
			"session-tree-rows",
			self.shown.len(),
			cx.processor(|this, range, _, cx| this.rows(range, cx)),
		)
		.track_scroll(&self.list)
		.flex_1()
		.min_h_0()
		.p(space::S1)
		.into_any_element()
	}

	/// The rows in `range`, which the list lays out this frame, and how many
	/// that is, which is what a page moves.
	fn rows(&mut self, range: Range<usize>, cx: &Context<Self>) -> Vec<AnyElement> {
		self.page = range.len().max(1);
		let palette = cx.theme().palette;
		let Some(tree) = self.tree(cx) else {
			return Vec::new();
		};
		let leaf = tree.leaf.as_ref();
		self
			.shown
			.get(range.clone())
			.unwrap_or_default()
			.iter()
			.zip(range)
			.filter_map(|(ix, row)| Some((row, tree.nodes.get(*ix)?)))
			.map(|(row, node)| self.row(row, node, leaf, &palette, cx))
			.collect()
	}

	/// Shown row `row`: a click puts the keyboard on it, a double click goes
	/// there.
	fn row(
		&self,
		row: usize,
		node: &SessionTreeNode,
		leaf: Option<&EntryId>,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let mark = if leaf == Some(&node.id) {
			Some(("●", palette.accent.base))
		} else {
			node.on_path.then_some(("•", palette.text.muted))
		};
		let leading = div()
			.flex()
			.items_center()
			.gap(space::S1)
			.child(
				div()
					.flex_none()
					.w(space::S3)
					.children(mark.map(|(glyph, color)| div().text_color(color).child(glyph))),
			)
			.when(!node.prefix.is_empty(), |leading| {
				leading.child(
					div()
						.flex_none()
						.text_color(tone(node.kind, palette))
						.child(node.prefix.clone()),
				)
			});
		let id = node.id.clone();
		let mut item = ListRow::new(("tree-row", row), node.text.clone())
			.selected(self.selected.as_ref() == Some(&node.id))
			.leading(leading)
			.on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
				this.click(&id, event.click_count(), window, cx);
			}));
		if let Some(label) = &node.label {
			item = item.trailing(
				div()
					.type_style(text::SMALL)
					.text_color(palette.accent.base)
					.child(label.clone()),
			);
		}
		div()
			.pl(space::S3 * node.depth as f32)
			.child(item)
			.into_any_element()
	}

	/// Puts the keyboard on `entry`, and goes there on a double click.
	fn click(&mut self, entry: &EntryId, count: usize, window: &mut Window, cx: &mut Context<Self>) {
		self.selected = Some(entry.clone());
		window.focus(&self.focus, cx);
		cx.notify();
		if count >= 2 {
			self.confirm(window, cx);
		}
	}

	/// Whether to summarize the branch left, the keyboard on `cursor`.
	fn summary(cursor: usize, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let choices = SUMMARY_CHOICES.iter().enumerate().map(|(ix, choice)| {
			ListRow::new(("tree-summary", ix), *choice)
				.selected(ix == cursor)
				.on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
					this.pick_summary(ix, window, cx);
				}))
		});
		div()
			.flex()
			.flex_col()
			.flex_1()
			.p(space::S1)
			.child(heading("Summarize the branch you leave?", palette))
			.children(choices)
			.into_any_element()
	}

	/// The field a step writes in, under `title`.
	fn field(&self, title: &'static str, palette: &Palette) -> AnyElement {
		div()
			.flex()
			.flex_col()
			.flex_1()
			.gap(space::S2)
			.p(space::S3)
			.child(heading(title, palette))
			.child(
				div()
					.px(space::S2)
					.py(space::S1)
					.rounded(radius::MD)
					.border_1()
					.border_color(palette.border.default)
					.bg(palette.bg.surface)
					.child(self.input.clone()),
			)
			.into_any_element()
	}

	/// What the sheet waits on, the host's refusal, a note, or the keys.
	fn status_line(&self, palette: &Palette) -> AnyElement {
		let (copy, color): (SharedString, Hsla) = match (&self.navigating, &self.status) {
			(Some(navigating), _) if navigating.aborted => {
				("Stopping the summary…".into(), palette.text.muted)
			},
			(Some(navigating), _) if navigating.summarize => {
				("Summarizing the branch… Escape stops it".into(), palette.text.muted)
			},
			(Some(_), _) => ("Moving to this entry…".into(), palette.text.muted),
			(None, Some(Status::Refused(reason))) => (reason.clone(), palette.status.error),
			(None, Some(Status::Note(note))) => ((*note).into(), palette.text.secondary),
			(None, None) => (hint(&self.step).into(), palette.text.faint),
		};
		div()
			.flex_none()
			.px(space::S3)
			.py(space::S1)
			.border_t_1()
			.border_color(palette.border.subtle)
			.type_style(text::SMALL)
			.text_color(color)
			.truncate()
			.child(copy)
			.into_any_element()
	}
}

/// The keys a step takes.
const fn hint(step: &Step) -> &'static str {
	match step {
		Step::Browse => "Enter goes here · Shift-L labels · Ctrl-O filters · Escape closes",
		Step::Summary { .. } => "Enter picks · Escape goes back",
		Step::Instructions { .. } | Step::Label { .. } => "Enter saves · Escape goes back",
	}
}

/// A filter's name on its chip.
const fn filter_label(filter: SessionTreeFilter) -> &'static str {
	match filter {
		SessionTreeFilter::Default => "Default",
		SessionTreeFilter::NoTools => "No tools",
		SessionTreeFilter::UserOnly => "User only",
		SessionTreeFilter::LabeledOnly => "Labeled only",
		SessionTreeFilter::All => "All",
	}
}

/// The tone a row's role marker is drawn in.
const fn tone(kind: SessionTreeEntryKind, palette: &Palette) -> Hsla {
	match kind {
		SessionTreeEntryKind::User => palette.accent.base,
		SessionTreeEntryKind::Developer => palette.status.info,
		SessionTreeEntryKind::Assistant => palette.status.success,
		SessionTreeEntryKind::ToolResult | SessionTreeEntryKind::Bash => palette.text.muted,
		SessionTreeEntryKind::CustomMessage => palette.syntax.attribute,
		SessionTreeEntryKind::Compaction | SessionTreeEntryKind::BranchSummary => {
			palette.status.waiting
		},
		SessionTreeEntryKind::ModelChange
		| SessionTreeEntryKind::ThinkingChange
		| SessionTreeEntryKind::Label
		| SessionTreeEntryKind::Custom
		| SessionTreeEntryKind::Other => palette.text.faint,
	}
}

/// A step's question, over what answers it.
fn heading(title: &'static str, palette: &Palette) -> AnyElement {
	div()
		.px(space::S2)
		.py(space::S1)
		.type_style(text::SMALL)
		.text_color(palette.text.muted)
		.child(title)
		.into_any_element()
}

/// A line standing in for the rows.
fn note(copy: &'static str, palette: &Palette) -> AnyElement {
	div()
		.flex_1()
		.px(space::S3)
		.py(space::S3)
		.type_style(text::UI)
		.text_color(palette.text.muted)
		.child(copy)
		.into_any_element()
}
