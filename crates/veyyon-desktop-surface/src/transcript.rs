//! The session surface: the transcript column and virtualized viewport (§5.2,
//! §5.3).
//!
//! The column is a fixed measure centred in whatever width is left over, so the
//! line length the operator reads does not change when the queue is resized or
//! the right panel opens. Everything a run produces is drawn at one of four
//! vertical gaps, and which gap applies is decided by what the two neighbouring
//! blocks are: two invocations in a row are one activity and sit tight, an
//! invocation followed by prose is a change of subject and sits apart. That is
//! the whole rhythm, and it is why a long run of tool calls reads as one band
//! rather than a list of unrelated rows.

pub mod blocks;
pub mod copy;
pub mod find;
pub mod fingerprint;
pub mod footer;
pub mod selection;
pub mod session_store;
pub mod state;
pub mod turn;
pub mod viewport;

pub use blocks::*;
pub use copy::*;
pub use find::*;
pub use fingerprint::*;
pub use footer::*;
pub use selection::*;
pub use session_store::*;
pub use state::*;
pub use turn::*;
use veyyon_desktop_kit::{ColorRole, TokenSet};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{IntoElement, ParentElement, Styled, div, px};
pub use viewport::*;

use crate::{
	damage::{LaidOut, Region},
	model::Turn,
};

/// Builds the static transcript column, centred in the space available.
///
/// Every turn's box is recorded in `laid_out` as the column is prepainted, so
/// a change to one turn can be repainted inside that turn alone (P5).
pub fn transcript_column(
	turns: &[Turn],
	geometry: &TranscriptSurfaceTokens,
	user_ground: ColorRole,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	laid_out: &LaidOut,
	measure_px: f32,
) -> impl IntoElement + use<> {
	let measure_px = geometry.column_width_px.min(measure_px);
	let mut column = div().flex().flex_col().w_full().max_w(px(measure_px));

	let static_state = TranscriptViewportState::new();
	static_state.sync_turns(turns, false);

	for (index, turn) in turns.iter().enumerate() {
		let is_last = index + 1 == turns.len();
		let mut block = render_turn(
			index,
			turn,
			is_last,
			false,
			1.0,
			&static_state,
			geometry,
			user_ground,
			tokens,
			motion_tokens,
			false,
			measure_px,
			laid_out,
			None,
			None,
		);

		if index > 0 {
			block = block.mt(px(geometry.turns_gap));
		}
		column = column.child(block);
	}

	div()
		.flex()
		.flex_row()
		.justify_center()
		.w_full()
		.child(laid_out.track_children(column, |index| Some(Region::Turn(index))))
}
