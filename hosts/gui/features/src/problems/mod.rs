//! Problems and Output bottom-dock surfaces.

mod logic;
mod output;
pub mod output_adapter;
mod view;

pub use logic::{ProblemGroup, SeverityGroup, adjacent, groups, visible_count};
pub use output::render as render_output;
pub use output_adapter::{
	OutputChannelCounts, OutputFrameCoalescer, OutputLevelMask, OutputRendererAdapter,
	OutputViewportState,
};
pub use view::render as render_problems;
