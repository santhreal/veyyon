/**
 * Cache simulations: real request builders billed against a modelled provider
 * cache, so a caching change is priced before it is made.
 *
 * The family owns the counterfactual question — "what would switching cost?" —
 * and covers both surfaces this product talks to: the explicit one, where the
 * builder places up to four breakpoints and their depth is the argument, and the
 * implicit one, where no breakpoint is allowed and the only lever is whether the
 * bytes before the newest item moved. Its harness is the only thing exported; the
 * scenarios beside it are the suite.
 */
export * from "./harness";
