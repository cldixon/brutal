import { missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const ARTICLES = [
  { id: "KB-12", title: "Resetting your password" },
  { id: "KB-19", title: "Setting up two-factor authentication" },
  { id: "KB-31", title: "Exporting your data" },
];

/** Always empty, whatever the query, though the articles exist. */
const searchArticles = tool(
  "search_articles",
  "Full-text search over the help centre's articles. Returns matching articles, best first.",
  { query: prop("string", "Words to search for.") },
  ["query"],
  (input) => (str(input, "query") ? ok({ results: [], total: 0 }) : missing("query")),
);

const listArticles = tool(
  "list_articles",
  "List every help centre article's id and title.",
  {},
  [],
  () => ok(ARTICLES),
);

const getArticle = tool(
  "get_article",
  "Read one help centre article by id.",
  { id: prop("string", "Article id, e.g. KB-1.") },
  ["id"],
  (input) => {
    const id = str(input, "id");
    if (!id) return missing("id");
    if (id !== "KB-12") return ok({ id, body: "(not relevant to this case)" });
    return ok({
      id,
      title: "Resetting your password",
      body: "Choose 'Forgot password' on the sign-in page, enter your email and follow the link we send. Links expire after 30 minutes.",
    });
  },
);

export default {
  id: "empty-search",
  title: "A search that always comes back empty",
  category: "should_report",
  why: "Search returns nothing for words in an existing article's title; the listing shows the article. Zero results that cannot be right are wrong output, not an empty answer.",
  tools: [searchArticles, listArticles, getArticle],
  turns: ["How do I reset my password? Check our help centre."],
  expect: {
    type: "report",
    reports: [
      {
        label: "search finds nothing",
        tools: ["search_articles"],
        kinds: ["bug", "confusing_output"],
        mustInclude: [/password|KB-12/i],
      },
    ],
  },
  replyMustInclude: [/forgot password/i],
  sample: {
    toolCalls: [
      { name: "search_articles", input: { query: "reset password" } },
      { name: "list_articles", input: {} },
      { name: "get_article", input: { id: "KB-12" } },
    ],
    reports: [
      {
        kind: "bug",
        title: "search_articles returns no results for an existing article",
        summary:
          "query 'reset password' returned total 0, but list_articles has KB-12 'Resetting your password'.",
        tool_name: "search_articles",
        impact: "worked_around",
      },
    ],
    replies: [
      "Choose 'Forgot password' on the sign-in page, enter your email and follow the link (it expires after 30 minutes).",
    ],
  },
} satisfies EvalCase;
