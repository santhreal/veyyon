//! How [`super::render`] draws a document: the root id, the prose step, the
//! code block copy button, deferred highlighting, the link handler and the
//! run each inline style draws.

use std::{rc::Rc, sync::Arc};

use veyyon_gpui::{
	AnyElement, App, ElementId, Font, FontStyle, FontWeight, Hsla, SharedString, StrikethroughStyle,
	TextRun, UnderlineStyle, Window, font,
};

use super::model::RunStyle;
use crate::{
	fonts::MONO_FAMILY,
	theme::{Palette, TypeStyle, size, text},
};

/// Builds the button in a code block's header that copies the block's code.
/// It receives the code and returns the element to place in the header.
pub type CopyButton = Rc<dyn Fn(Arc<str>, &mut Window, &mut App) -> AnyElement>;

/// Handles a click on a link. It receives the link's URL.
pub type LinkHandler = Rc<dyn Fn(Arc<str>, &mut Window, &mut App)>;

/// How [`super::render`] draws a document.
#[derive(Clone)]
pub struct MarkdownStyle {
	/// The id of the root element. It namespaces the ids of the links and
	/// scroll regions inside, so it is unique among its siblings.
	pub id:                 ElementId,
	/// The type ramp step of prose; headings and code use their own steps.
	pub prose:              TypeStyle,
	/// The copy button of each code block, or none.
	pub copy_button:        Option<CopyButton>,
	/// Whether a code block draws only a cached highlight result and draws
	/// plain text on a miss, leaving [`super::highlight`] to the caller, for
	/// example on a background executor followed by a notify.
	pub deferred_highlight: bool,
	/// What a click on a link runs, or none to open the URL with
	/// `App::open_url`.
	pub on_link:            Option<LinkHandler>,
}

impl MarkdownStyle {
	/// Prose in [`text::BODY`], code blocks without a copy button and links
	/// opened with `App::open_url`.
	pub fn new(id: impl Into<ElementId>) -> Self {
		Self {
			id:                 id.into(),
			prose:              text::BODY,
			copy_button:        None,
			deferred_highlight: false,
			on_link:            None,
		}
	}

	/// Places the element `build` returns in the header of each code block.
	pub fn copy_button(
		mut self,
		build: impl Fn(Arc<str>, &mut Window, &mut App) -> AnyElement + 'static,
	) -> Self {
		self.copy_button = Some(Rc::new(build));
		self
	}

	/// Draws code blocks from [`super::cached`] results only, and plain on a
	/// miss.
	pub const fn deferred_highlight(mut self) -> Self {
		self.deferred_highlight = true;
		self
	}

	/// Runs `handle` with a link's URL when the link is clicked, instead of
	/// opening the URL.
	pub fn on_link(mut self, handle: impl Fn(Arc<str>, &mut Window, &mut App) + 'static) -> Self {
		self.on_link = Some(Rc::new(handle));
		self
	}
}

/// The run that draws `len` bytes styled `style` in type step `step`, prose
/// in `color`. `strong` sets it semibold, as a table header does.
pub(super) fn text_run(
	style: &RunStyle,
	len: usize,
	step: TypeStyle,
	strong: bool,
	color: Hsla,
	palette: &Palette,
) -> TextRun {
	let family = if style.code { MONO_FAMILY } else { step.family };
	TextRun {
		len,
		font: Font {
			weight: if style.bold || strong {
				FontWeight::SEMIBOLD
			} else {
				step.weight
			},
			style: if style.italic {
				FontStyle::Italic
			} else {
				FontStyle::Normal
			},
			..font(SharedString::new_static(family))
		},
		color: if style.link.is_some() {
			palette.accent.base
		} else {
			color
		},
		background_color: style.code.then_some(palette.code.bg),
		underline: style.link.as_ref().map(|_| UnderlineStyle {
			thickness: size::HAIRLINE,
			color:     Some(palette.accent.base),
			wavy:      false,
		}),
		strikethrough: style
			.strike
			.then_some(StrikethroughStyle { thickness: size::HAIRLINE, color: None }),
		..TextRun::default()
	}
}
