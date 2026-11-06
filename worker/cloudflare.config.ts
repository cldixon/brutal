import { defineBrutal } from "./config.ts";

// The owner's settings are in brutal.config.json (gitignored; `bun run setup` writes it). CI uses
// brutal.config.example.json through BRUTAL_CONFIG.
export default defineBrutal({ dir: import.meta.dirname, entrypoint: "./src/index.ts" });
