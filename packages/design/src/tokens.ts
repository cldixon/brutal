/**
 * Brutal's design tokens: one flat list, each a CSS custom property `--brutal-<name>` in
 * tokens.css. Black on white, one display face (Archivo Black, for the wordmark and headings),
 * the system's fonts for everything else, heavy rules and hard offset shadows that echo the
 * wordmark's extrusion. tokens.css must say the same (test/tokens.test.ts checks it).
 */
export const TOKENS = {
  // Colour: black and white, a grey for secondary text (7:1 on paper) and a tint for code.
  "color-ink": "#000",
  "color-paper": "#fff",
  "color-muted": "#555",
  "color-tint": "#f2f2f2",

  // Type
  "font-display": '"Archivo Black", "Arial Black", Impact, sans-serif',
  "font-body": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "text-xs": "0.8125rem",
  "text-sm": "0.9375rem",
  "text-base": "1.0625rem",
  "text-lg": "1.25rem",
  "text-xl": "1.75rem",
  "text-2xl": "2.5rem",
  "text-3xl": "clamp(2.5rem, 6vw, 4rem)",
  "leading-tight": "1.05",
  "leading-body": "1.6",

  // Space (a 4 px base)
  "space-1": "0.25rem",
  "space-2": "0.5rem",
  "space-3": "1rem",
  "space-4": "1.5rem",
  "space-5": "2.5rem",
  "space-6": "4rem",
  "space-7": "6rem",

  // Rules and edges: square corners, black lines in three weights.
  "rule-hair": "1px",
  rule: "3px",
  "rule-heavy": "6px",
  radius: "0",

  // The extrusion: the wordmark's depth step (scales with its font size, 18 steps) and its
  // outline, and the hard shadow boxes and buttons take from it.
  "extrude-step": "0.0075em",
  "extrude-stroke": "max(1.5px, 0.03em)",
  shadow: "6px 6px 0 #000",
  "shadow-small": "3px 3px 0 #000",

  // Layout
  measure: "42rem",
  page: "72rem",
  gutter: "1.5rem",
  target: "44px",
} as const;

export type TokenName = keyof typeof TOKENS;

/** The CSS custom property a token is published as. */
export const cssVar = (name: TokenName): string => `--brutal-${name}`;
