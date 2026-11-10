/**
 * Brutal's design tokens: one flat list, each a CSS custom property `--brutal-<name>` in
 * tokens.css. Black on white, one display face (Archivo Black, for the wordmark and headings),
 * the system's fonts for everything else, and the wordmark's extrusion. tokens.css must say the same (test/tokens.test.ts checks it).
 */
export const TOKENS = {
  // Colour: black and white, a grey for secondary text (7:1 on paper), a tint for code, and a
  // grey for secondary text on black (9:1 on ink).
  "color-ink": "#000",
  "color-paper": "#fff",
  "color-muted": "#555",
  "color-tint": "#f2f2f2",
  "color-muted-inverse": "#aaa",

  // Type
  "font-display": '"Archivo Black", "Arial Black", Impact, sans-serif',
  "font-body": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "text-sm": "0.9375rem",
  "text-base": "1.0625rem",
  "text-lg": "1.25rem",
  "text-xl": "1.75rem",
  "text-2xl": "2.5rem",
  "leading-tight": "1.05",
  "leading-body": "1.6",

  // Space (a 4 px base)
  "space-1": "0.25rem",
  "space-2": "0.5rem",
  "space-3": "1rem",
  "space-4": "1.5rem",
  "space-5": "2.5rem",
  "space-6": "4rem",

  // Rules
  "rule-hair": "1px",

  // The wordmark's extrusion: its depth step (scales with its font size, 18 steps) and outline.
  "extrude-step": "0.0075em",
  "extrude-stroke": "max(1.5px, 0.03em)",

  // Layout
  measure: "42rem",
  gutter: "1.5rem",
  target: "44px",
} as const;

export type TokenName = keyof typeof TOKENS;

/** The CSS custom property a token is published as. */
export const cssVar = (name: TokenName): string => `--brutal-${name}`;
