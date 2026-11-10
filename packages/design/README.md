# @brutal-ai/design

Brutal's design tokens, its one web font and its wordmark, for every surface to share. The site
(`site/web`) uses all of it; the app, the consent page and the operator's portal still have their
own small stylesheets and can move onto these tokens next.

- `src/tokens.ts` and `src/tokens.css`: the same list, as a TypeScript object and as CSS custom
  properties `--brutal-<name>`. Change both; `test/tokens.test.ts` fails when they differ.
- `src/fonts.css`: Archivo Black (OFL 1.1), self-hosted from `@fontsource/archivo-black`, so a
  page needs only `font-src 'self'`.
- `src/wordmark.css`: `.brutal-wordmark`, the extruded "BRUTAL": a white face outlined in black
  with a solid black extrusion whose depth scales with the font size.

The look, plain for now: black on white, the system's fonts for text and code, Archivo Black for
the wordmark and headings. The extruded wordmark is the one loud thing.

```ts
import "@brutal-ai/design/tokens.css";
import "@brutal-ai/design/fonts.css";
import "@brutal-ai/design/wordmark.css";
```
