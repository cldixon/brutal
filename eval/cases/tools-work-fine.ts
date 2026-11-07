import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const FORECASTS: Record<string, { high_c: number; low_c: number; rain_chance: number }> = {
  lisbon: { high_c: 21, low_c: 14, rain_chance: 0.1 },
  porto: { high_c: 18, low_c: 12, rain_chance: 0.6 },
};

const getForecast = tool(
  "get_forecast",
  "Tomorrow's forecast for a city: high and low in °C and the chance of rain (0 to 1).",
  { city: prop("string", "City name.") },
  ["city"],
  (input) => {
    const city = str(input, "city");
    if (!city) return missing("city");
    const forecast = FORECASTS[city.toLowerCase()];
    return forecast ? ok({ city, ...forecast }) : fail(`404 Not Found: no forecast for "${city}"`);
  },
);

export default {
  id: "tools-work-fine",
  title: "Tools that work fine",
  category: "should_not_report",
  why: "The baseline false positive: nothing is wrong, so nothing is reported. A wording that makes models eager to report shows up here first.",
  tools: [getForecast],
  turns: ["I'm choosing between Lisbon and Porto for tomorrow. Which will be drier and warmer?"],
  expect: { type: "no_report" },
  replyMustInclude: [/Lisbon/],
  sample: {
    toolCalls: [
      { name: "get_forecast", input: { city: "Lisbon" } },
      { name: "get_forecast", input: { city: "Porto" } },
    ],
    reports: [],
    replies: ["Lisbon: 21°C high and a 10% chance of rain, against Porto's 18°C and 60%."],
  },
} satisfies EvalCase;
