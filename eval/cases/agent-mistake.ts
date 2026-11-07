import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const WEATHER: Record<string, { city: string; country: string; temp_c: number }> = {
  "paris,us": { city: "Paris", country: "US", temp_c: 31 },
  "paris,fr": { city: "Paris", country: "FR", temp_c: 12 },
};

const getWeather = tool(
  "get_weather",
  "Current weather for a city. `country` is an ISO 3166 code.",
  { city: prop("string", "City name."), country: prop("string", "ISO 3166-1 alpha-2 code.") },
  ["city", "country"],
  (input) => {
    const city = str(input, "city");
    const country = str(input, "country");
    if (!city) return missing("city");
    if (!country) return missing("country");
    const found = WEATHER[`${city.toLowerCase()},${country.toLowerCase()}`];
    return found ? ok(found) : fail(`404 Not Found: no station for ${city}, ${country}`);
  },
);

export default {
  id: "agent-mistake",
  title: "The agent's own mistake, pointed out by the user",
  category: "should_not_report",
  why: "Earlier in the conversation the agent asked for Paris, US; the tool answered correctly for Paris, Texas. When the user objects, the fix is the agent's, not a report.",
  tools: [getWeather],
  history: [
    { user: "What's the weather in Paris right now?" },
    { call: "get_weather", input: { city: "Paris", country: "US" } },
    { assistant: "It's 31°C in Paris right now." },
  ],
  turns: ["31°C in November? That can't be right for Paris."],
  expect: { type: "no_report" },
  replyMustInclude: [/12/],
  sample: {
    toolCalls: [{ name: "get_weather", input: { city: "Paris", country: "FR" } }],
    reports: [],
    replies: ["Sorry, I looked up Paris, Texas. Paris, France is 12°C right now."],
  },
} satisfies EvalCase;
