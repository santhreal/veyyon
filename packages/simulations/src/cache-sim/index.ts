/**
 * Cache simulations: real request builders billed against a modelled provider
 * cache, so a caching change is priced before it is made.
 *
 * The family owns the counterfactual question — "what would switching cost?" —
 * and its harness is the only thing exported; the scenarios beside it are the
 * suite.
 */
export * from "./harness";
