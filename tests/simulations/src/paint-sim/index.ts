/**
 * Paint simulations: the real TUI engine driven against a scripted screen.
 *
 * The family owns everything about a frame reaching the terminal wrong — a
 * whole-screen repaint nobody asked for, an erased scrollback, a row of
 * history that stopped being there. Its harness is the only thing exported;
 * the scenarios beside it are the suite.
 */
export * from "./harness";
