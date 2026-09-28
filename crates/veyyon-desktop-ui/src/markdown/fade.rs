//! Streamed text fading in. An offset here counts the drawn text: the text
//! of every run of prose and every code block, in the order
//! [`super::render`] draws them.

use std::ops::Range;

use veyyon_gpui::{
	App, HighlightStyle, TextRun, Window,
	motion::{Animator, FrameInstant, MotionDriver},
};

use super::{MarkdownDoc, model::Block};
use crate::theme::motion;

#[cfg(test)]
mod tests;

/// Where a run of streamed text starts in the drawn text, and the opacity the
/// text from there to the next stop is drawn at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FadeStop {
	/// The offset in the drawn text the run starts at.
	pub start:   usize,
	/// The opacity of the run, 0 to 1.
	pub opacity: f32,
}

/// The runs of a streamed document still fading in.
///
/// Each frame that draws text past what the last frame drew starts that
/// text fading in from [`motion::STREAM_FADE_FROM`] to opaque under
/// [`motion::STREAM_FADE`], so the first frame already shows it. A frame is
/// requested only while a run fades, and under reduced motion nothing fades.
#[derive(Default)]
pub struct StreamFade {
	runs:   Vec<(usize, Animator<FrameInstant>)>,
	stops:  Vec<FadeStop>,
	drawn:  usize,
	driver: MotionDriver,
}

impl StreamFade {
	/// Forgets the drawn text, so the next text drawn fades in whole.
	pub fn clear(&mut self) {
		self.runs.clear();
		self.stops.clear();
		self.drawn = 0;
	}

	/// The stops the last frame drew with.
	pub fn stops(&self) -> &[FadeStop] {
		&self.stops
	}

	/// Brings the fade to this frame for a document whose drawn text is `len`
	/// long and returns the stops to draw it with. Text past what the last
	/// frame drew starts fading in; a text shorter than that was replaced and
	/// is drawn opaque.
	pub fn step(&mut self, len: usize, window: &mut Window, cx: &App) -> &[FadeStop] {
		if len < self.drawn {
			self.runs.clear();
		} else if len > self.drawn {
			let policy = cx.motion_policy();
			if !policy.reduced() {
				let mut run = Animator::at_rest(motion::STREAM_FADE_FROM);
				run.retarget(1.0, motion::STREAM_FADE, policy, cx.frame_instant());
				self.runs.push((self.drawn, run));
			}
		}
		self.drawn = len;
		self.stops.clear();
		if self.runs.is_empty() {
			return &self.stops;
		}
		let mut frame = self.driver.begin(cx);
		for (_, run) in &mut self.runs {
			frame.track(run);
		}
		self.driver.end(frame, window);
		// A run that reached opaque this frame is drawn as plain text.
		self.runs.retain(|(_, run)| !run.is_at_rest());
		self.stops.extend(
			self
				.runs
				.iter()
				.map(|(start, run)| FadeStop { start: *start, opacity: run.value() }),
		);
		&self.stops
	}
}

/// The length of the drawn text of `doc`.
pub fn drawn_len(doc: &MarkdownDoc) -> usize {
	blocks_len(doc.blocks())
}

fn blocks_len(blocks: &[Block]) -> usize {
	blocks
		.iter()
		.map(|block| match block {
			Block::Paragraph(inlines) | Block::Heading { runs: inlines, .. } => inlines.text.len(),
			Block::CodeBlock { code, .. } => code.len(),
			Block::List { items, .. } => items.iter().map(|item| blocks_len(item)).sum(),
			Block::Quote(blocks) => blocks_len(blocks),
			Block::Table { head, rows, .. } => head
				.iter()
				.chain(rows.iter().flatten())
				.map(|cell| cell.text.len())
				.sum(),
			Block::TaskItem { .. } | Block::Rule => 0,
		})
		.sum()
}

/// Whether drawn text from `base`, `len` long, has a part below full
/// opacity under `stops`.
pub(super) fn fades(stops: &[FadeStop], base: usize, len: usize) -> bool {
	stops
		.iter()
		.any(|stop| stop.opacity < 1.0 && stop.start < base + len)
}

/// `runs`, the runs of `text` drawn from offset `base`, split where a stop
/// starts and drawn at the stop's opacity.
pub(super) fn fade_runs(
	runs: Vec<TextRun>,
	text: &str,
	base: usize,
	stops: &[FadeStop],
) -> Vec<TextRun> {
	let mut faded = Vec::with_capacity(runs.len() + stops.len());
	let mut at = 0;
	for run in runs {
		let end = at + run.len;
		match text.get(at..end) {
			Some(part) => {
				for (piece, opacity) in pieces(part, base + at, stops) {
					faded.push(TextRun { len: piece.len(), ..at_opacity(&run, opacity) });
				}
			},
			None => faded.push(run),
		}
		at = end;
	}
	faded
}

/// The highlights that draw `text`, drawn from offset `base`, at the
/// opacity of each stop.
pub(super) fn fade_highlights<'a>(
	text: &'a str,
	base: usize,
	stops: &'a [FadeStop],
) -> impl Iterator<Item = (Range<usize>, HighlightStyle)> + 'a {
	pieces(text, base, stops)
		.filter(|(_, opacity)| *opacity < 1.0)
		.map(|(range, opacity)| {
			(range, HighlightStyle { fade_out: Some(1.0 - opacity), ..HighlightStyle::default() })
		})
}

/// `run` drawn at `opacity`.
fn at_opacity(run: &TextRun, opacity: f32) -> TextRun {
	let mut run = run.clone();
	if opacity < 1.0 {
		run.color = run.color.opacity(opacity);
		run.background_color = run.background_color.map(|color| color.opacity(opacity));
		if let Some(underline) = run.underline.as_mut() {
			underline.color = underline.color.map(|color| color.opacity(opacity));
		}
	}
	run
}

/// The pieces of `text`, drawn from offset `base`, that one stop covers,
/// each with its opacity. Piece edges fall on character boundaries.
fn pieces<'a>(
	text: &'a str,
	base: usize,
	stops: &'a [FadeStop],
) -> impl Iterator<Item = (Range<usize>, f32)> + 'a {
	let mut from = 0;
	std::iter::from_fn(move || {
		if from >= text.len() {
			return None;
		}
		let opacity = stops
			.iter()
			.rev()
			.find(|stop| stop.start <= base + from)
			.map_or(1.0, |stop| stop.opacity);
		let mut to = stops
			.iter()
			.find(|stop| stop.start > base + from)
			.map_or(text.len(), |stop| (stop.start - base).min(text.len()));
		while !text.is_char_boundary(to) {
			to += 1;
		}
		let piece = from..to;
		from = to;
		Some((piece, opacity))
	})
}
