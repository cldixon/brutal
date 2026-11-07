import {
  AgentInput,
  type Context,
  type ReportInput,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_NOT_RECORDED,
  type ToolCall,
  toolAck,
  toolDefinition,
} from "@brutal-ai/schema";

/**
 * The TypeScript SDK. Give the agent the `report_feedback` tool, wrap its other tools so their
 * recent calls are recorded, and every report the agent files arrives with that context attached.
 * The agent supplies only its judgment. Delivery never slows or fails the agent's turn.
 *
 *   const brutal = createBrutal({ endpoint, ingestKey, context: () => ({ app_version }) });
 *   const convo = brutal.conversation(conversationId);
 *   const search = convo.wrap("search_parts", searchParts);
 *   tools: [brutal.anthropicTool(), …]; on a report_feedback call: await convo.handle(input)
 *
 * Other shapes: openaiTool, openaiResponsesTool, bedrockTool, aiSdkTool, mastraTool, langchainTool.
 */

export interface BrutalOptions {
  /** The Brutal Worker's URL, e.g. https://brutal.example.workers.dev. */
  endpoint: string;
  /** An ingest key: it can only submit reports. Keep it on the server. */
  ingestKey: string;
  /** Context added to every report: app version, branch, environment, model, agent name. */
  context?: () => Partial<Context>;
  /** Last chance to scrub a report before it leaves the app; return null to drop it. */
  redact?: (report: ReportInput) => ReportInput | null;
  /** How many recent tool calls to keep per conversation (default 20). */
  maxRecentCalls?: number;
  /** Characters kept of each recorded call's args and result (default 2000). */
  maxFieldChars?: number;
  /** How long a report may take before it is given up on (default 3000 ms). */
  timeoutMs?: number;
  /** Told when a report could not be delivered. Never thrown to the agent. */
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
}

/** How many conversations' buffers are kept; the least recently used goes first. */
const MAX_CONVERSATIONS = 1000;
const SDK_VERSION = "0.3.0";

export function createBrutal(options: BrutalOptions) {
  const maxCalls = options.maxRecentCalls ?? 20;
  const maxChars = options.maxFieldChars ?? 2000;
  const timeoutMs = options.timeoutMs ?? 3000;
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const buffers = new Map<string, ToolCall[]>();

  const clip = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    const text = typeof value === "string" ? value : safeJson(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}… (${text.length} chars)` : value;
  };

  function bufferFor(conversationId: string): ToolCall[] {
    let buffer = buffers.get(conversationId);
    if (buffer) {
      buffers.delete(conversationId); // Re-insert, so the Map's order is least recently used first.
    } else {
      buffer = [];
      if (buffers.size >= MAX_CONVERSATIONS) {
        const oldest = buffers.keys().next().value;
        if (oldest !== undefined) buffers.delete(oldest);
      }
    }
    buffers.set(conversationId, buffer);
    return buffer;
  }

  function record(conversationId: string, call: ToolCall): void {
    const buffer = bufferFor(conversationId);
    buffer.push({
      ...call,
      args: clip(call.args),
      result: clip(call.result),
      error: call.error?.slice(0, maxChars),
      at: call.at ?? new Date().toISOString(),
    });
    if (buffer.length > maxCalls) buffer.splice(0, buffer.length - maxCalls);
  }

  /**
   * Sends one report. Resolves true when it was stored; never rejects. One retry on a network
   * error or a 5xx, within the timeout.
   */
  async function report(input: ReportInput): Promise<boolean> {
    return (await send(input)) !== null;
  }

  /** Sends one report: the stored report's id, "" if stored with none given, null if not stored. */
  async function send(input: ReportInput): Promise<string | null> {
    try {
      const shaped = options.redact ? options.redact(input) : input;
      if (!shaped) return null;
      const body = JSON.stringify(shaped);
      const deadline = AbortSignal.timeout(timeoutMs);
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(`${endpoint}/v1/reports`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.ingestKey}`,
              "content-type": "application/json",
            },
            body,
            signal: deadline,
          });
        } catch (error) {
          if (attempt >= 1 || deadline.aborted) throw error;
          continue;
        }
        if (res.ok) {
          const stored = (await res.json().catch(() => null)) as { id?: unknown } | null;
          return typeof stored?.id === "string" ? stored.id : "";
        }
        if (res.status < 500 || attempt >= 1) {
          throw new Error(`brutal: ${res.status} ${await res.text()}`);
        }
      }
    } catch (error) {
      options.onError?.(error);
      return null;
    }
  }

  /** One conversation: its recorder, and the tool handler that attaches what it recorded. */
  function conversation(conversationId: string, extra: Partial<Context> = {}) {
    return {
      /** Records one tool call by hand. */
      record: (call: ToolCall) => record(conversationId, call),

      /** Wraps a tool so each call is recorded with its args, result or error, and latency. */
      wrap<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>) {
        return async (...args: A): Promise<R> => {
          const started = performance.now();
          const shownArgs = args.length === 1 ? args[0] : args;
          try {
            const result = await fn(...args);
            record(conversationId, {
              name,
              args: shownArgs,
              status: "ok",
              latency_ms: Math.round(performance.now() - started),
              result,
            });
            return result;
          } catch (error) {
            record(conversationId, {
              name,
              args: shownArgs,
              status: "error",
              latency_ms: Math.round(performance.now() - started),
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        };
      },

      /** The recorded calls, oldest first. */
      recent: (): ToolCall[] => [...(buffers.get(conversationId) ?? [])],

      /**
       * Handles the agent's `report_feedback` call: validates its input, attaches the context
       * and recent tool calls, sends it, and returns the line to give back to the agent. A bad
       * input is still sent (as `other`), so the report is not lost to a model's mistake.
       */
      async handle(input: unknown): Promise<string> {
        const parsed = AgentInput.safeParse(input);
        const agent: AgentInput = parsed.success
          ? parsed.data
          : {
              kind: "other",
              title: "Unparsed report_feedback call",
              summary: "The agent's report did not match the tool's schema.",
              details: safeJson(input).slice(0, 10_000),
            };
        const id = await send({
          ...agent,
          context: {
            ...options.context?.(),
            ...extra,
            conversation_id: conversationId,
            recent_tool_calls: [...(buffers.get(conversationId) ?? [])],
            sdk: "@brutal-ai/sdk",
            sdk_version: SDK_VERSION,
          },
        });
        return id === null ? TOOL_NOT_RECORDED : toolAck(id || "no id");
      },
    };
  }

  return {
    report,
    conversation,
    /** The canonical tool: name, description, JSON Schema. */
    definition: toolDefinition,
    /** The tool for the Anthropic Messages API (`tools: [...]`). */
    anthropicTool() {
      const { name, description, input_schema } = toolDefinition();
      return { name, description, input_schema };
    },
    /**
     * The tool for OpenAI's Chat Completions API (`tools: [...]`). Not strict: strict mode needs
     * every property required, and most of this tool's fields are optional. On a
     * `report_feedback` tool call, `await convo.handle(JSON.parse(call.function.arguments))`.
     */
    openaiTool() {
      const { name, description } = toolDefinition();
      return {
        type: "function" as const,
        function: { name, description, parameters: parameters(), strict: false },
      };
    },
    /**
     * The tool for OpenAI's Responses API (`tools: [...]`), which is flat, not nested under
     * `function`, and strict unless told otherwise. On a `function_call` item named
     * `report_feedback`, `await convo.handle(JSON.parse(item.arguments))`.
     */
    openaiResponsesTool() {
      const { name, description } = toolDefinition();
      return {
        type: "function" as const,
        name,
        description,
        parameters: parameters(),
        strict: false,
      };
    },
    /**
     * The tool for Amazon Bedrock's Converse API (`toolConfig: { tools: [...] }`). On a `toolUse`
     * block named `report_feedback`, answer with a `toolResult` whose text is
     * `await convo.handle(toolUse.input)`.
     */
    bedrockTool() {
      const { name, description } = toolDefinition();
      return { toolSpec: { name, description, inputSchema: { json: parameters() } } };
    },
    /**
     * The tool for the Vercel AI SDK (`tools: { report_feedback: … }`): a zod schema, which the
     * AI SDK takes as is, and an `execute` bound to one conversation.
     */
    aiSdkTool(conversationId: string, extra: Partial<Context> = {}) {
      const convo = conversation(conversationId, extra);
      return { description: TOOL_DESCRIPTION, inputSchema: AgentInput, execute: convo.handle };
    },
    /**
     * The tool for a Mastra agent (`tools: { report_feedback: … }`, or through `createTool`):
     * an id, a zod schema and an `execute` bound to one conversation.
     */
    mastraTool(conversationId: string, extra: Partial<Context> = {}) {
      const convo = conversation(conversationId, extra);
      return {
        id: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: AgentInput,
        execute: (input: unknown) => convo.handle(input),
      };
    },
    /**
     * The fields of a LangChain.js tool, bound to one conversation:
     * `new DynamicStructuredTool(brutal.langchainTool(id))`, or `tool(t.func, t)`.
     */
    langchainTool(conversationId: string, extra: Partial<Context> = {}) {
      const convo = conversation(conversationId, extra);
      return {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        schema: AgentInput,
        func: (input: unknown) => convo.handle(input),
      };
    },
    toolName: TOOL_NAME,
  };
}

export type Brutal = ReturnType<typeof createBrutal>;

/** A JSON value, typed so it assigns to the AWS SDK's `DocumentType` as well as to a record. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The tool's JSON Schema without its `$schema` line, for the APIs that take a bare schema. */
function parameters(): { [key: string]: Json } {
  const { $schema: _, ...schema } = toolDefinition().input_schema as { [key: string]: Json };
  return schema;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
