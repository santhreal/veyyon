//! What each virtualized list lays out beyond its viewport, so a fast scroll
//! finds the next rows already measured.
//!
//! A budget, not an authored measure: changing one moves no drawn pixel, only
//! how far ahead GPUI works, which is why it is stated here rather than in a
//! token file where every entry is swept against the raster.

/// The queue rail, a little over one card of rows.
pub const QUEUE_PX: f32 = 100.0;

/// The settings page, one row.
pub const SETTINGS_PX: f32 = 44.0;

/// The transcript, whose turns are tall and scrolled fastest.
pub const TRANSCRIPT_PX: f32 = 200.0;
