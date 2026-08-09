import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { requireAuth } from "../lib/jwt.js";
import { streamChat, chatOnce } from "../lib/ollama.js";
import { chatOnceProvider, streamProviderChat, type ProviderConfig } from "../lib/providers.js";
import { decryptSecret } from "../lib/crypto.js";
import { trimHistory } from "../lib/history.js";
import { retrieveRelevantChunks, buildContextBlock } from "../lib/rag.js";
import { canUseModel } from "../lib/permissions.js";
import { webSearch, buildSearchContextBlock, webSearchEnabled } from "../lib/websearch.js";
import { getMemoryContextBlock, extractAndSaveMemory } from "../lib/memory.js";
import { buildToolsSystemBlock, parseToolCall, executeTool, looksLikeImageRequest } from "../lib/tools.js";
import { runPipelines } from "../lib/pipelines.js";
import { runFilters } from "../lib/functions-sandbox.js";
import { logEvent } from "../lib/logger.js";
import { assertTokenQuota, recordTokenUsage, QuotaExceededError } from "../lib/quota.js";
import { mergeContinuation } from "../lib/continuation.js";
import { dispatchWebhook } from "../lib/webhooks.js";
import { buildIdentityBlock } from "../lib/identity.js";
import { loadUploadLimits } from "../lib/uploads.js";
import { safeDisplayName, scrubQwenMentions } from "../lib/model-display.js";

const GENERATED_IMAGE_RE = /!\[Generated image\]\(data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+\/=]+)\)/;

// What a genuine tool_call JSON blob always starts with (after trimming
// leading whitespace) — used to tell a real tool call apart from an
// ordinary "{" the model writes as part of normal output (CSS rules, JS
// objects, JSON examples in prose). See withStallTimeout below for the
// unrelated stall-watchdog helper.
const TOOL_CALL_PREFIX = '{"tool_call"';

// Wraps an async chunk generator (Ollama/provider stream) so that a
// silently wedged connection — no error, just no more chunks ever
// arriving, seen with some local models mid-generation on a long file —
// throws after a period of silence instead of leaving the `for await`
// loop (and the client's SSE connection) hanging forever. Resets on every
// chunk received, so this only fires on genuine silence, not a
// slow-but-alive stream.
const STALL_TIMEOUT_MS = 60_000;
async function* withStallTimeout<T>(iterable: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Model stream stalled: no data received for 60s")),
        STALL_TIMEOUT_MS
      );
    });
    let result;
    try {
      result = await Promise.race([iterator.next(), timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
    if (result.done) return;
    yield result.value;
  }
}

function extractGeneratedImage(content: string): { text: string; image?: string } {
  const match = content.match(GENERATED_IMAGE_RE);
  if (!match) return { text: content };
  return { text: content.replace(match[0], "[Generated image]"), image: match[1] };
}

// `chat.model` for an external-provider model looks like
// "provider:<providerId>:<realModelName>" (see routes/models.ts, which is
// what generates that name). This resolves it back to a decrypted
// ProviderConfig plus the plain model name the provider's own API expects.
// Returns null for any model that isn't provider-routed (plain Ollama tag
// or "pipe:<slug>"), so callers can fall through to the Ollama path.
async function resolveProviderModel(
  prisma: FastifyInstance["prisma"],
  model: string
): Promise<{ config: ProviderConfig; modelName: string } | null> {
  if (!model.startsWith("provider:")) return null;
  const rest = model.slice("provider:".length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex === -1) return null;
  const providerId = rest.slice(0, separatorIndex);
  const modelName = rest.slice(separatorIndex + 1);
  const provider = await prisma.aiProvider.findUnique({ where: { id: providerId } });
  if (!provider || !provider.enabled) return null;
  return {
    config: {
      type: provider.type as ProviderConfig["type"],
      apiKey: decryptSecret(provider.apiKeyEncrypted),
      baseUrl: provider.baseUrl,
    },
    modelName,
  };
}

// Hard cap on extra tool rounds an agent-mode turn can take beyond the
// first one — bounds cost/latency and guards against a model looping on
// a tool that keeps "succeeding" without ever answering.
const MAX_AGENT_STEPS = 5;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttachedTool = { tool: any };

// The engine behind Agent Mode (this platform's own build — not a
// wrapper around any third-party agent product): once the first tool
// call of a turn has already run (see the `call` branch in the messages
// route below), this keeps letting the model decide "call another tool"
// vs. "answer now" for up to MAX_AGENT_STEPS more rounds, executing each
// tool as it's requested and feeding the result back in, the same
// request/response shape Claude Code's own tool loop uses. Every round
// but the very last is a fast non-streamed detection call (mirrors the
// existing single-tool-call detection pattern above); the actual final
// answer is left to stream normally once this returns.
async function runAgentLoop(opts: {
  app: FastifyInstance;
  chat: { model: string };
  userId: string;
  chatId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelMessages: any[];
  attachedTools: AttachedTool[];
  genOptions: { temperature?: number; top_p?: number; stop?: string[]; num_predict?: number };
  toolDetectNumPredict: number | undefined;
  pushStep: (type: string, label: string, status: "start" | "done" | "error", detail?: string) => void;
  writeSse: (payload: Record<string, unknown>) => void;
}): Promise<{ done: boolean; content: string; promptTokens?: number; completionTokens?: number }> {
  const { app, chat, userId, chatId, modelMessages, attachedTools, genOptions, toolDetectNumPredict, pushStep, writeSse } = opts;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const providerModel = await resolveProviderModel(app.prisma, chat.model);
    let content: string;
    try {
      const result = providerModel
        ? await chatOnceProvider(providerModel.config, {
            model: providerModel.modelName,
            messages: modelMessages,
            temperature: genOptions.temperature,
            top_p: genOptions.top_p,
            stop: genOptions.stop,
            num_predict: toolDetectNumPredict,
          })
        : await chatOnce({ model: chat.model, messages: modelMessages, ...genOptions, num_predict: toolDetectNumPredict });
      content = scrubQwenMentions(result.content);
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    } catch (err) {
      return {
        done: true,
        content: "Sorry, er ging iets mis tijdens een agent-stap. Probeer het opnieuw.",
        promptTokens,
        completionTokens,
      };
    }

    const call = parseToolCall(content);
    if (!call) {
      // Model chose to answer instead of calling another tool — that
      // text IS the final answer, already fully generated.
      return { done: true, content, promptTokens, completionTokens };
    }

    const link = attachedTools.find((l) => l.tool.name === call.name);
    let output: string;
    let toolError: string | undefined;
    try {
      output = link ? await executeTool(link.tool, call.arguments, app.prisma, { userId, currentChatId: chatId }) : "";
      if (!link) toolError = `Tool "${call.name}" is not attached to this chat.`;
    } catch (err) {
      output = "";
      toolError = err instanceof Error ? err.message : String(err);
      logEvent(app.prisma, "ERROR", "tool", `Tool "${call.name}" failed: ${toolError}`, { chatId });
    }
    const resultContent = toolError ? `Error: ${toolError}` : output;
    pushStep(
      "tool",
      toolError ? `Tool "${call.name}" failed` : `Tool "${call.name}" completed`,
      toolError ? "error" : "done",
      resultContent
    );
    await app.prisma.message.create({
      data: { chatId, role: "TOOL", toolName: call.name, content: JSON.stringify({ arguments: call.arguments, result: resultContent }) },
    });
    writeSse({ tool: { name: call.name, arguments: call.arguments, result: resultContent } });

    if (call.name === "generate_image" && !toolError) {
      return { done: true, content: resultContent, promptTokens, completionTokens };
    }

    modelMessages.push(
      { role: "assistant", content },
      { role: "system", content: `Tool "${call.name}" returned: ${resultContent}` }
    );
  }

  // Step cap reached — stop calling tools and force a wrap-up answer on
  // the next (streamed) pass instead of looping forever.
  modelMessages.push({
    role: "system",
    content:
      "You have reached the maximum number of tool calls for this turn. Answer the user's original question now using everything gathered so far. Do not call another tool.",
  });
  return { done: false, content: "", promptTokens, completionTokens };
}

export default async function chatsRoutes(app: FastifyInstance) {
  // ---- List / search chats ----
  app.get("/chats", { preHandler: requireAuth }, async (req) => {
    const { id } = req.user as { id: string };
    const { q, archived } = req.query as { q?: string; archived?: string };
    const chats = await app.prisma.chat.findMany({
      where: {
        userId: id,
        // Archived chats are hidden from the normal sidebar list — pass
        // ?archived=true to see only archived ones instead.
        archived: archived === "true",
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      include: { _count: { select: { messages: true } } },
    });
    return { chats };
  });

  // ---- Create chat ----
  app.post("/chats", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.user as { id: string };
    const { model, title, folderId } = z
      .object({ model: z.string(), title: z.string().optional(), folderId: z.string().optional() })
      .parse(req.body);

    if (!(await canUseModel(app.prisma, id, model))) {
      return reply.code(403).send({ error: "No access to this model" });
    }

    const chat = await app.prisma.chat.create({
      data: { userId: id, model, title: title ?? "New chat", folderId },
    });

    // ---- Default tools: if an admin picked built-in/HTTP tools for this
    // model (Tools tab in Model Params), attach them to the chat now so
    // the model has them from message one — same idea as defaultFeatures,
    // but tools need an actual ChatTool row rather than a UI toggle. ----
    const modelSetting = await app.prisma.modelSetting.findUnique({ where: { name: model } });
    const defaultToolIds = Array.isArray(modelSetting?.defaultToolIds)
      ? (modelSetting!.defaultToolIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    if (defaultToolIds.length > 0) {
      const validTools = await app.prisma.tool.findMany({
        where: { id: { in: defaultToolIds }, enabled: true },
        select: { id: true },
      });
      if (validTools.length > 0) {
        await app.prisma.chatTool.createMany({
          data: validTools.map((t) => ({ chatId: chat.id, toolId: t.id })),
        });
      }
    }

    return { chat };
  });

  // ---- Rename / pin / move to folder ----
  app.patch("/chats/:chatId", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const body = z
      .object({
        title: z.string().optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        folderId: z.string().nullable().optional(),
        model: z.string().optional(),
        systemPrompt: z.string().nullable().optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        topP: z.number().min(0).max(1).nullable().optional(),
        numCtx: z.number().min(512).max(131072).nullable().optional(),
        agentMode: z.boolean().optional(),
      })
      .parse(req.body);

    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId: id } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    if (body.model && !(await canUseModel(app.prisma, id, body.model))) {
      return reply.code(403).send({ error: "No access to this model" });
    }

    const updated = await app.prisma.chat.update({ where: { id: chatId }, data: body });
    return { chat: updated };
  });

  // ---- Sharing: generate/rotate a public read-only link ----
  app.post("/chats/:chatId/share", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId: id } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    // Reuse an existing token if one exists (idempotent re-share), otherwise
    // mint a new one. crypto.randomUUID gives us plenty of entropy without
    // pulling in an extra dependency.
    const shareId = chat.shareId ?? crypto.randomUUID();
    const updated = await app.prisma.chat.update({
      where: { id: chatId },
      data: { shareId, isPublic: true },
    });
    return { shareId: updated.shareId };
  });

  // ---- Sharing: revoke ----
  app.delete("/chats/:chatId/share", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId: id } });
    if (!chat) return reply.code(404).send({ error: "Not found" });
    // Only flip isPublic — keep shareId around so re-sharing later reuses
    // the same link instead of invalidating anything a user bookmarked.
    await app.prisma.chat.update({ where: { id: chatId }, data: { isPublic: false } });
    return { ok: true };
  });

  // ---- Public read-only view of a shared chat. No auth — anyone with the
  // link can view (not modify). Deliberately excludes flagged/system
  // messages and TOOL role internals; only USER/ASSISTANT content is shown
  // so a shared link never leaks moderation state or raw tool payloads. ----
  app.get("/public/chats/:shareId", async (req, reply) => {
    const { shareId } = req.params as { shareId: string };
    const chat = await app.prisma.chat.findFirst({
      where: { shareId, isPublic: true },
      include: {
        messages: {
          where: { role: { in: ["USER", "ASSISTANT"] } },
          orderBy: { createdAt: "asc" },
          select: { id: true, role: true, content: true, createdAt: true },
        },
      },
    });
    if (!chat) return reply.code(404).send({ error: "Not found or no longer shared" });
    // No admin-override lookup here on purpose — this endpoint is public/
    // unauthenticated, so it always falls back to the scrubbed name rather
    // than ever showing a raw "qwen..." tag to an anonymous visitor.
    const modelSetting = await app.prisma.modelSetting.findUnique({
      where: { name: chat.model },
      select: { displayName: true },
    });
    const displayModel = modelSetting?.displayName ?? safeDisplayName(chat.model);
    return { chat: { id: chat.id, title: chat.title, model: displayModel, messages: chat.messages } };
  });

  // ---- Delete chat ----
  app.delete("/chats/:chatId", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId: id } });
    if (!chat) return reply.code(404).send({ error: "Not found" });
    await app.prisma.chat.delete({ where: { id: chatId } });
    return { ok: true };
  });

  // ---- Get chat + messages ----
  app.get("/chats/:chatId", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const chat = await app.prisma.chat.findFirst({
      where: { id: chatId, userId: id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!chat) return reply.code(404).send({ error: "Not found" });
    return { chat };
  });

  // ---- Edit a previously-sent USER message ----
  // Only the message's own content changes here; everything that came
  // after it (the old assistant reply, and any later turns) is deleted
  // since it was a response to text that no longer exists. The client
  // follows this up with a `regenerate: true` call to get a fresh answer
  // against the edited content.
  app.patch("/chats/:chatId/messages/:messageId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId, messageId } = req.params as { chatId: string; messageId: string };
    const { content } = z.object({ content: z.string().min(1) }).parse(req.body);

    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    const message = await app.prisma.message.findFirst({ where: { id: messageId, chatId } });
    if (!message) return reply.code(404).send({ error: "Not found" });
    if (message.role !== "USER") return reply.code(422).send({ error: "Only user messages can be edited" });

    // Tokens spent on ASSISTANT replies that are about to be discarded
    // (they answered text that no longer exists) — tallied onto the
    // user's lifetime wastedTokens counter before the rows are deleted.
    const discarded = await app.prisma.message.findMany({
      where: { chatId, createdAt: { gt: message.createdAt }, role: "ASSISTANT" },
      select: { promptTokens: true, completionTokens: true },
    });
    const wasted = discarded.reduce((sum, m) => sum + (m.promptTokens ?? 0) + (m.completionTokens ?? 0), 0);

    const [updated] = await app.prisma.$transaction([
      app.prisma.message.update({ where: { id: messageId }, data: { content } }),
      app.prisma.message.deleteMany({ where: { chatId, createdAt: { gt: message.createdAt } } }),
      ...(wasted > 0 ? [app.prisma.user.update({ where: { id: userId }, data: { wastedTokens: { increment: wasted } } })] : []),
    ]);

    return { message: updated };
  });

  // ---- Rate an ASSISTANT message (thumbs up/down) ----
  app.post("/chats/:chatId/messages/:messageId/rating", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId, messageId } = req.params as { chatId: string; messageId: string };
    // null clears a rating (pressing the same thumb again toggles it off).
    const { rating } = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.null()]) }).parse(req.body);

    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    const message = await app.prisma.message.findFirst({ where: { id: messageId, chatId } });
    if (!message) return reply.code(404).send({ error: "Not found" });
    if (message.role !== "ASSISTANT") return reply.code(422).send({ error: "Only assistant messages can be rated" });

    // A thumbs-down means the answer wasn't useful — count its tokens as
    // wasted too, but only on the transition into -1 so toggling the same
    // rating on/off repeatedly can't inflate the counter.
    const becomingDownvoted = rating === -1 && message.rating !== -1;
    const leavingDownvoted = rating !== -1 && message.rating === -1;
    const tokenDelta = becomingDownvoted
      ? (message.promptTokens ?? 0) + (message.completionTokens ?? 0)
      : leavingDownvoted
        ? -((message.promptTokens ?? 0) + (message.completionTokens ?? 0))
        : 0;

    const [updated] = await app.prisma.$transaction([
      app.prisma.message.update({ where: { id: messageId }, data: { rating } }),
      ...(tokenDelta !== 0
        ? [app.prisma.user.update({ where: { id: userId }, data: { wastedTokens: { increment: tokenDelta } } })]
        : []),
    ]);
    return { message: updated };
  });

  // ---- Send a message and stream the assistant's reply back over SSE ----
  // Supports: stop generating (client just aborts the fetch),
  // regenerate (client resends with `regenerate: true`, we drop the last
  // assistant message first), continue (client resends last assistant
  // content as context and asks the model to keep going).
  app.post(
    "/chats/:chatId/messages",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const body = z
      .object({
        content: z.string(),
        regenerate: z.boolean().optional(),
        continueGeneration: z.boolean().optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        num_ctx: z.number().optional(),
        webSearch: z.boolean().optional(),
        // Base64-encoded image data (no data: prefix), vision models only.
        // Ignored by text-only models, so it's always safe to send.
        images: z.array(z.string()).max(4).optional(),
        // Browser geolocation, opt-in via the "Share your location" banner
        // on the empty chat screen. Sent once per message (not stored on
        // the chat) since the user's position can change between turns.
        location: z.object({ lat: z.number(), lon: z.number() }).optional(),
      })
      .parse(req.body);

    if (body.images && body.images.length > 0) {
      const { imageUploadEnabled } = await loadUploadLimits(app.prisma);
      if (!imageUploadEnabled) {
        return reply.code(403).send({ error: "Image attachments are currently disabled by the administrator." });
      }
    }

    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    let continueTargetId: string | null = null;
    let userMessageId: string | null = null;
    // Generated up front (instead of letting Prisma's cuid() default fill
    // it in later) so it can be sent to the client in the meta SSE event
    // below, before the row actually exists — the assistant bubble is
    // created client-side immediately and needs a real id from the start,
    // the same way the user bubble does, so Edit/regenerate on either
    // message works without a page reload.
    const assistantMessageId = crypto.randomUUID();

    // Rolling-window token quota (see lib/quota.ts — group quota, plan
    // quota, or the DEFAULT_TOKEN_QUOTA fallback). Checked up front, before
    // ANY path that triggers a model call — a new message, a regenerate, or
    // a continue all cost real tokens/compute, so all three have to respect
    // the limit. (Regenerate/continue used to skip this entirely, which let
    // an over-quota user keep generating forever just by hitting those two
    // buttons instead of typing a new message.) This only blocks *starting*
    // a turn once already over budget — the actual token cost of this turn
    // is recorded after generation finishes, once it's known (see
    // recordTokenUsage below).
    try {
      await assertTokenQuota(app.prisma, userId);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
      }
      throw err;
    }

    if (body.regenerate) {
      const last = await app.prisma.message.findFirst({
        where: { chatId, role: "ASSISTANT" },
        orderBy: { createdAt: "desc" },
      });
      if (last) {
        const wasted = (last.promptTokens ?? 0) + (last.completionTokens ?? 0);
        await app.prisma.$transaction([
          app.prisma.message.delete({ where: { id: last.id } }),
          ...(wasted > 0 ? [app.prisma.user.update({ where: { id: userId }, data: { wastedTokens: { increment: wasted } } })] : []),
        ]);
      }
    } else if (body.continueGeneration) {
      // "Continue" resumes the last assistant message rather than sending
      // a new user turn — no filters/pipeline run (nothing new was
      // actually said) and the existing message gets appended to instead
      // of a new one being created below. Quota is still checked above,
      // same as every other path.
      const last = await app.prisma.message.findFirst({
        where: { chatId, role: "ASSISTANT" },
        orderBy: { createdAt: "desc" },
      });
      if (!last) return reply.code(422).send({ error: "Nothing to continue" });
      continueTargetId = last.id;
    } else {
      // Filters (inlet): admin Python code, run before Pipeline's regex
      // rules. A filter can rewrite body.content (e.g. redact, translate,
      // enrich) or block the message outright if its code errors — see
      // lib/functions-sandbox.ts for the fail-closed rationale. Runs
      // before anything is persisted, same reasoning as the PRE pipeline.
      const inletResult = await runFilters(
        app.prisma,
        "inlet",
        chat.model,
        { content: body.content },
        { id: userId, email: (req.user as { email: string }).email, role: (req.user as { role: string }).role }
      );
      if (inletResult.blocked) {
        return reply.code(422).send({ error: inletResult.blocked });
      }
      body.content = inletResult.body.content;

      // PRE pipeline stage: evaluate before anything is persisted or sent
      // to the model, so a BLOCK never touches history or costs a model call.
      const preResult = await runPipelines(app.prisma, "PRE", body.content);
      if (preResult.outcome === "BLOCK") {
        logEvent(app.prisma, "WARN", "pipeline", `Blocked message via rule "${preResult.ruleName}"`, {
          chatId,
        });
        dispatchWebhook(app.prisma, "PIPELINE_BLOCKED", { chatId, userId, rule: preResult.ruleName });
        return reply.code(422).send({ error: preResult.message, rule: preResult.ruleName });
      }

      const created = await app.prisma.message.create({
        data: { chatId, role: "USER", content: body.content, images: body.images ?? [] },
      });
      userMessageId = created.id;
      dispatchWebhook(app.prisma, "MESSAGE_SENT", { chatId, userId, messageId: created.id });
      if (preResult.outcome === "FLAG") {
        await app.prisma.message.update({
          where: { id: created.id },
          data: { flagged: true, flagReason: preResult.reason },
        });
        dispatchWebhook(app.prisma, "MESSAGE_FLAGGED", { chatId, userId, messageId: created.id, reason: preResult.reason });
      }
    }

    const history = await app.prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
    });

    // ---- "What the AI did and thought" — every RAG/search/tool action
    // taken while producing this reply, in order, plus the model's own
    // chain-of-thought (see `reasoningFull` further down). Streamed to the
    // client live as `step` SSE events (so the UI can show a running
    // "Denken..." timeline instead of a silent gap), then persisted onto
    // the assistant message so it's still visible after a reload.
    //
    // The SSE stream has to open here (before RAG/search run) rather than
    // its old spot further down, specifically so these steps can be
    // streamed as they happen instead of only after generation starts.
    // Everything that can still reject with a normal HTTP status code
    // (auth, quota, pipeline BLOCK) has already run above this point.
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(
      `data: ${JSON.stringify({ meta: { userMessageId, assistantMessageId: continueTargetId ? null : assistantMessageId } })}\n\n`
    );

    type Step = { type: string; label: string; status: "start" | "done" | "error"; detail?: string; at: string };
    const steps: Step[] = [];
    const pushStep = (type: string, label: string, status: Step["status"], detail?: string) => {
      const step: Step = { type, label, status, ...(detail ? { detail } : {}), at: new Date().toISOString() };
      steps.push(step);
      reply.raw.write(`data: ${JSON.stringify({ step })}\n\n`);
    };

    // ---- RAG: if documents are attached to this chat, retrieve the most
    // relevant chunks for the user's latest message and inject them as a
    // system message ahead of the conversation history. ----
    const attachedDocs = await app.prisma.chatDocument.findMany({
      where: { chatId, document: { status: "READY" } },
      select: { documentId: true },
    });
    let contextBlock = "";
    if (attachedDocs.length > 0) {
      pushStep("rag", "Searching documents", "start");
      const chunks = await retrieveRelevantChunks(
        app.prisma,
        attachedDocs.map((d) => d.documentId),
        body.content || history[history.length - 1]?.content || "",
        5
      );
      contextBlock = buildContextBlock(chunks);
      pushStep("rag", "Searched documents", "done", `${chunks.length} relevant chunks found`);
    }

    // ---- Web search: only runs when the client explicitly toggles it on
    // for this message. Failures here are non-fatal — if SearXNG is down
    // or the query errors out, we just skip the context block and let the
    // model answer from its own knowledge rather than failing the whole
    // request. ----
    let searchBlock = "";
    if (body.webSearch && !body.regenerate && (await webSearchEnabled(app.prisma))) {
      pushStep("websearch", "Searching the web", "start", body.content);
      try {
        const results = await webSearch(body.content, 5, app.prisma);
        searchBlock = buildSearchContextBlock(body.content, results);
        pushStep("websearch", "Searched the web", "done", `${results.length} results found`);
      } catch (err) {
        app.log.warn({ err }, "web search failed, continuing without it");
        pushStep("websearch", "Web search failed", "error", String(err));
      }
    }

    // ---- Tools: chat-scoped catalog only — the model never sees tools
    // that haven't been explicitly attached to this chat. ----
    const [explicitlyAttachedTools, autoTools] = await Promise.all([
      app.prisma.chatTool.findMany({
        where: { chatId },
        include: { tool: true },
      }),
      app.prisma.tool.findMany({
        where: { type: "BUILTIN", enabled: true },
      }),
    ]);
    // Merge chat-attached tools with always-on builtin tools into a single
    // list, in the same { tool: PrismaTool } shape as chatTool rows, so both
    // the system-prompt block AND the execution/lookup logic further down
    // use exactly the same source of truth. (Previously the execution logic
    // used the un-merged `attachedTools` while the prompt used the merged
    // set, so the model would be told about e.g. generate_image and call it,
    // but the call would never actually run.)
    const toolById = new Map(explicitlyAttachedTools.map((l) => [l.tool.id, l]));
    for (const t of autoTools) {
      if (!toolById.has(t.id)) toolById.set(t.id, { tool: t } as (typeof explicitlyAttachedTools)[number]);
    }
    const attachedTools = [...toolById.values()];
    const toolBlock = buildToolsSystemBlock(attachedTools.map((l) => l.tool));

    // ---- Location: only present when the client sent one (user opted in
    // via the location banner) and this is a genuinely new turn — a
    // regenerate/continue re-send shouldn't re-inject it as if the user
    // said something new. ----
    const locationBlock =
      body.location && !body.regenerate && !body.continueGeneration
        ? `The user's approximate coordinates are latitude ${body.location.lat}, longitude ${body.location.lon}. Use this only if their question depends on where they are (e.g. local weather, nearby places, timezone); otherwise ignore it.`
        : "";

    // ---- Model-level defaults (admin "Model Params" editor) — only
    // fetched when the chat itself doesn't already override the thing in
    // question, so a per-chat systemPrompt/temperature/etc always wins
    // over the model's default, and an explicit per-message generation
    // param (body.temperature etc, sent by the chat settings drawer)
    // wins over both. ----
    const modelSetting =
      chat.systemPrompt == null || chat.temperature == null || chat.topP == null || chat.numCtx == null
        ? await app.prisma.modelSetting.findUnique({ where: { name: chat.model } })
        : null;
    const modelParams = (modelSetting?.params as Record<string, unknown> | null) ?? null;
    const modelStop = Array.isArray(modelParams?.stop)
      ? (modelParams!.stop as string[])
      : typeof modelParams?.stop === "string"
        ? [modelParams!.stop as string]
        : undefined;

    // Persistent per-chat system prompt (from Prompt Library or manually
    // set) comes first — falling back to the model's configured default
    // system prompt when the chat has none — then the RAG context block,
    // then live search results, then the tool catalog, then location,
    // then history. All blocks are optional and independent.
    // ---- Memory: what's been learned about this user across past
    // conversations (see lib/memory.ts) — a name and a short list of
    // durable facts, gated by the memoriesEnabled/memorySystemContextEnabled
    // admin toggles. Empty string when memory is off or nothing's stored
    // yet, same optional-block pattern as everything else here. ----
    const memoryBlock = await getMemoryContextBlock(app.prisma, userId);

    // ---- Identity lock: hardcoded, always sent — see lib/identity.ts for
    // why this can't live in the admin-editable System Prompt field. ----
    const identityUser = await app.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const identityBlock = buildIdentityBlock(identityUser?.name ?? null, new Date());

    const systemBlocks = [
      identityBlock,
      chat.systemPrompt ?? modelSetting?.systemPrompt,
      memoryBlock,
      contextBlock,
      searchBlock,
      toolBlock,
      locationBlock,
    ].filter(Boolean) as string[];

    // For continueGeneration, the instruction to "keep going" has to go
    // BEFORE the last assistant message, not after it. Ollama's /api/chat
    // only enters continuation mode (literally appending to the message)
    // when the LAST item in `messages` has role "assistant" — if anything
    // follows it, Ollama treats it as the start of a fresh turn instead,
    // which is what was causing the model to restart/repeat the whole
    // answer rather than continue it.
    let lastGeneratedImage: string | undefined;

    const trimmedHistory = trimHistory(history).map((m) => {
      const role = m.role.toLowerCase() as "user" | "assistant" | "system";
      if (role === "assistant") {
        const { text, image } = extractGeneratedImage(m.content);
        if (image) lastGeneratedImage = image;
        return {
          role,
          content: text,
        };
      }
      return {
        role,
        content: m.content,
        ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
      };
    });

    // If a generated image exists and the last message is from the user
    // and doesn't already carry its own uploaded image, attach the most
    // recently generated image so the model can actually see it.
    if (lastGeneratedImage) {
      const lastMsg = trimmedHistory[trimmedHistory.length - 1];
      if (lastMsg && lastMsg.role === "user" && !("images" in lastMsg && lastMsg.images && lastMsg.images.length > 0)) {
        (lastMsg as any).images = [lastGeneratedImage];
      }
    }

    const modelMessages = continueTargetId
      ? [
          ...systemBlocks.map((content) => ({ role: "system" as const, content })),
          { role: "system" as const, content: "Continue your previous response exactly where it left off. Do not repeat any of it, do not add a greeting or preamble — just keep writing." },
          ...trimmedHistory,
        ]
      : [
          ...systemBlocks.map((content) => ({ role: "system" as const, content })),
          ...trimmedHistory,
        ];

    const genOptions = {
      temperature: body.temperature ?? chat.temperature ?? (modelParams?.temperature as number | undefined),
      top_p: body.top_p ?? chat.topP ?? (modelParams?.top_p as number | undefined),
      // If nothing configures this anywhere (chat/model/request), don't
      // leave it undefined — Ollama's own fallback is a mere 2048 tokens,
      // which the identity block, tool catalog, memory block, and (now
      // default-on) web search results alone can eat into badly, leaving
      // little to no room for actual conversation history. That reads to
      // the user as the model "losing the thread" or randomly changing
      // topic mid-chat, when really its context window just got trimmed
      // out from under it. 16384 leaves clear headroom above
      // MAX_HISTORY_TOKENS (lib/history.ts, 8000 by default) for the
      // system blocks plus the model's own response — 8192 would leave
      // almost nothing once history alone fills most of it.
      num_ctx: body.num_ctx ?? chat.numCtx ?? (modelParams?.num_ctx as number | undefined) ?? 16384,
      seed: modelParams?.seed as number | undefined,
      stop: modelStop,
      num_predict: modelParams?.max_tokens as number | undefined,
      // GPU/NPU offload — Ollama-only, ignored by the provider branch below.
      // `0` here (the field's default/empty state in the admin Model
      // Params editor) must NOT be forwarded as a literal num_gpu=0 —
      // Ollama takes that as "offload zero layers", i.e. force CPU-only,
      // which is never what "leave this field alone" was meant to do.
      // Only a genuine positive override should ever reach Ollama; an
      // unset or zeroed field means "let Ollama auto-detect", same as
      // omitting the option entirely.
      num_gpu: (modelParams?.num_gpu as number | undefined) || undefined,
      num_thread: modelParams?.num_thread as number | undefined,
    };

    // (SSE stream + meta event already sent above, right before the
    // RAG/websearch steps, so those steps can be streamed live.)

    let full = "";
    let reasoningFull = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    // ---- Pipe models: chat.model of the form "pipe:<slug>" is not an
    // Ollama model at all — it's a custom provider defined by an admin
    // Pipe (lib/functions-sandbox.ts). Runs once, non-streamed (the
    // sandbox returns a full string, not a token stream), then the rest
    // of this handler treats `full` exactly like a normal completion. ----
    if (chat.model.startsWith("pipe:")) {
      const { invokePipeBySlug } = await import("./pipes.js");
      const slug = chat.model.slice("pipe:".length);
      const pipeResult = await invokePipeBySlug(app, slug, body.content, {
        id: userId,
        email: (req.user as { email: string }).email,
        role: (req.user as { role: string }).role,
      });
      if (!pipeResult.ok) {
        reply.raw.write(`data: ${JSON.stringify({ error: pipeResult.error })}\n\n`);
        reply.raw.end();
        return;
      }
      full = scrubQwenMentions(pipeResult.body.content);
      if (!continueTargetId) reply.raw.write(`data: ${JSON.stringify({ token: full, done: true })}\n\n`);
    }

    // ---- Tool-calling round: only when this chat has tools attached, and
    // limited to a single round-trip (call at most one tool, then answer)
    // to keep latency bounded and avoid loops. If no tool call is detected,
    // the non-streaming reply we already have becomes the final answer —
    // we don't pay for a second model call just to re-stream identical
    // text. ----
    if (attachedTools.length > 0 && !full) {
      let firstPass = "";
      // Some local models (esp. reasoning models like Qwen3, but not only
      // in "think" mode) prepend a sentence or two of plain prose to the
      // *content* channel before the tool_call JSON itself — e.g. "Ik zoek
      // nu naar je vorige chats.\n\n{"tool_call": ...}" — instead of
      // emitting pure JSON as their very first character. `sawBrace` /
      // `toolCallBuffer` track that: everything before the first "{" is
      // genuine prose and safe to stream live, everything from the first
      // "{" onward is buffered separately so it can be parsed as a
      // tool_call once complete, instead of leaking the raw JSON to the
      // user as if it were more prose.
      let sawBrace = false;
      let toolCallBuffer = "";
      // True once we've decided a "{" that triggered buffering above
      // was a false alarm (ordinary CSS/JS/JSON-in-prose, not an actual
      // tool_call) — see the TOOL_CALL_PREFIX check where tokens are
      // processed below.
      let toolCallAbandoned = false;
      // ---- Deterministic fast path: if the user's own message clearly
      // asks for an image (in Dutch or English, any common phrasing — see
      // looksLikeImageRequest), call generate_image directly instead of
      // asking the model to decide via the tool_call JSON protocol. Small
      // local models are unreliable at recognizing indirect requests, so
      // this guarantees it works "elke manier" the user asks, not just
      // when the message happens to contain the word "image". Skipped for
      // regenerate/continue, where body.content isn't a fresh request.
      const hasImageTool = attachedTools.some((l) => l.tool.name === "generate_image");
      let call: { name: string; arguments: Record<string, unknown> } | null =
        hasImageTool && !body.regenerate && !continueTargetId && looksLikeImageRequest(body.content)
          ? { name: "generate_image", arguments: { prompt: body.content } }
          : null;

      // The tool-detection round (and its retry below) needs enough
      // headroom to fit an entire tool_call JSON blob — for generate_image
      // that includes the whole (often long) image prompt as a JSON string
      // value. Reusing the chat's own num_predict here means a low
      // user-configured max_tokens can truncate the JSON mid-string before
      // it closes its braces, which makes parseToolCall() fail (unbalanced
      // JSON -> null) and leaves the raw, broken "{"tool_call": ...}" text
      // to leak straight into the visible answer instead of being
      // executed. Floor it well above any reasonable JSON payload size for
      // this round only — the user's real max_tokens still applies to the
      // actual streamed answer once a tool call (or its absence) is
      // resolved.
      // 700 was sized for generate_image's JSON blob (prompt text only,
      // rarely more than a few hundred tokens). create_file's JSON blob
      // has to fit the *entire file content* as a JSON string value —
      // a generated script or config can easily run to several thousand
      // tokens. When the buffer got cut off mid-string, parseToolCall()
      // failed (unbalanced JSON -> null), and the raw, broken
      // `{"tool_call": {"name": "create_file", ... unterminated` text
      // leaked straight into the visible answer instead of being executed
      // — give create_file (and any other attached tool) much more
      // headroom than a plain image prompt needs.
      const hasFileTool = attachedTools.some((l) => l.tool.name === "create_file");
      const TOOL_DETECTION_MIN_PREDICT = hasFileTool ? 8000 : 700;
      const toolDetectNumPredict =
        genOptions.num_predict === undefined
          ? undefined
          : Math.max(genOptions.num_predict, TOOL_DETECTION_MIN_PREDICT);

      if (!call) {
        // Hybrid streaming: we still need to see the model's reply before
        // knowing whether it's a tool_call JSON blob or a normal prose
        // answer, but blocking on the *entire* completion (the old
        // chatOnce/chatOnceProvider call) meant that whenever the model
        // just answered directly — e.g. writing out a whole code file
        // inline instead of calling a tool — nothing reached the client
        // until generation finished, then the full answer landed in one
        // giant chunk ("hij laat niet zien met code schrijven, pas eind
        // gooit ie hele bericht"). So we stream from the very first token:
        // anything before the first "{" can only be prose and goes to the
        // client live, same as a normal streamed answer. The moment a "{"
        // shows up we stop forwarding and buffer from there instead
        // (toolCallBuffer/sawBrace) — some models prepend a sentence of
        // prose before the tool_call JSON, so "first character isn't `{`"
        // is not a safe test for "no tool call is coming".
        let reasoningStarted = false;
        try {
          const providerModel = await resolveProviderModel(app.prisma, chat.model);
          const chunks = providerModel
            ? streamProviderChat(providerModel.config, {
                model: providerModel.modelName,
                messages: modelMessages,
                temperature: genOptions.temperature,
                top_p: genOptions.top_p,
                stop: genOptions.stop,
                num_predict: toolDetectNumPredict,
              })
            : streamChat({ model: chat.model, messages: modelMessages, ...genOptions, num_predict: toolDetectNumPredict });
          for await (const chunk of withStallTimeout(chunks)) {
            const reasoningToken = scrubQwenMentions(chunk.message?.thinking ?? "");
            if (reasoningToken) {
              if (!reasoningStarted) {
                reasoningStarted = true;
                pushStep("reasoning", "Thinking", "start");
              }
              reasoningFull += reasoningToken;
              reply.raw.write(`data: ${JSON.stringify({ reasoning: reasoningToken, done: false })}\n\n`);
            }

            const token = scrubQwenMentions(chunk.message?.content ?? "");
            if (token) {
              firstPass += token;
              if (!sawBrace) {
                const braceIdx = token.indexOf("{");
                if (braceIdx === -1) {
                  // Still plain prose so far — safe to stream live.
                  if (!continueTargetId) {
                    reply.raw.write(`data: ${JSON.stringify({ token, done: false })}\n\n`);
                  }
                } else {
                  // A "{" just showed up — anything before it in *this*
                  // token is still genuine prose (stream it), anything
                  // from here on goes into the tool-call buffer instead
                  // of straight to the client, UNLESS it turns out this
                  // brace wasn't the start of a tool_call at all (see
                  // TOOL_CALL_PREFIX check below) — a "{" is extremely
                  // common in ordinary output (CSS rules, JS objects,
                  // JSON examples the model writes out), and treating
                  // every one as "maybe a tool call" used to silently
                  // buffer the rest of the reply and only flush it as one
                  // giant blob once generation finished, instead of
                  // streaming it live.
                  sawBrace = true;
                  const prosePart = token.slice(0, braceIdx);
                  const jsonPart = token.slice(braceIdx);
                  if (prosePart && !continueTargetId) {
                    reply.raw.write(`data: ${JSON.stringify({ token: prosePart, done: false })}\n\n`);
                  }
                  toolCallBuffer += jsonPart;
                }
              } else if (toolCallAbandoned) {
                // Already confirmed this isn't a tool call — back to
                // streaming everything live.
                if (!continueTargetId) {
                  reply.raw.write(`data: ${JSON.stringify({ token, done: false })}\n\n`);
                }
              } else {
                toolCallBuffer += token;
                // As soon as we have enough characters to compare against
                // `{"tool_call"`, check whether the buffer is actually
                // consistent with it. If not, this was an ordinary brace
                // (CSS/JS/JSON-in-prose) — give up buffering, flush
                // everything gathered so far live, and resume live
                // streaming for the rest of the reply.
                // Compare with whitespace stripped out on both sides — some
                // models (e.g. this project's own "Jean" model) format the
                // JSON with spaces after "{" and after ":" (`{ "tool_call":
                // ...`) instead of the tight `{"tool_call":...}` the system
                // prompt models. A literal character-position comparison
                // against TOOL_CALL_PREFIX broke on the very first space,
                // marked the block "abandoned", and leaked the raw JSON to
                // the user as plain text instead of executing it.
                const trimmed = toolCallBuffer.trimStart();
                const compact = trimmed.replace(/\s+/g, "");
                const compactPrefix = TOOL_CALL_PREFIX.replace(/\s+/g, "");
                const compareLen = Math.min(compact.length, compactPrefix.length);
                const matchesSoFar = compact.slice(0, compareLen) === compactPrefix.slice(0, compareLen);
                if (!matchesSoFar) {
                  toolCallAbandoned = true;
                  if (!continueTargetId && toolCallBuffer) {
                    reply.raw.write(`data: ${JSON.stringify({ token: toolCallBuffer, done: false })}\n\n`);
                  }
                  toolCallBuffer = "";
                }
              }
            }

            if (chunk.done) {
              if (reasoningStarted) pushStep("reasoning", "Done thinking", "done");
              promptTokens = chunk.prompt_eval_count;
              completionTokens = chunk.eval_count;
              break;
            }
          }
        } catch (err) {
          // Same reasoning as the final-answer round below: if plain prose
          // was already streamed live (the !sawBrace path above sends
          // tokens to the client as they arrive), a stall/error here
          // shouldn't wipe that out — close the reply out with what we
          // have instead of a hard error that makes the client discard it.
          if ((!sawBrace || toolCallAbandoned) && firstPass.trim()) {
            full = firstPass;
            if (!continueTargetId) {
              reply.raw.write(
                `data: ${JSON.stringify({ token: "", done: true, usage: { promptTokens, completionTokens } })}\n\n`
              );
            }
          } else {
            reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
            reply.raw.end();
            return;
          }
        }

        if (!full && (!sawBrace || toolCallAbandoned)) {
          // No "{" ever appeared, or one did but turned out not to be a
          // tool call — confirmed prose, already streamed live above,
          // nothing left to detect or parse, just close out the answer.
          full = firstPass;
          if (!continueTargetId) {
            reply.raw.write(
              `data: ${JSON.stringify({ token: "", done: true, usage: { promptTokens, completionTokens } })}\n\n`
            );
          }
        } else if (!full) {
          // Sommige (lokale) reasoning-modellen stoppen de tool_call-JSON in het
          // native "thinking"-kanaal in plaats van in `content` — content blijft
          // dan leeg en parseToolCall(firstPass) zou hem nooit vinden. Val in
          // dat geval terug op reasoningFull. Parse from toolCallBuffer (the
          // part from the first "{" onward), not firstPass — firstPass may
          // still carry a genuine prose prefix that was already streamed
          // live and isn't part of the JSON block.
          call = parseToolCall(toolCallBuffer) ?? (reasoningFull ? parseToolCall(reasoningFull) : null);
        }
      }
      // Vangnet: sommige modellen negeren de instructie en typen zelf de
      // placeholdertekst "[Generated image]" na (nagebootst uit eerdere
      // berichten in de geschiedenis) in plaats van de tool aan te roepen.
      // Detecteer dat en forceer alsnog een generate_image call met de
      // laatste user-prompt als argument.
      if (!call && !full && /\[Generated image\]/i.test(firstPass) && attachedTools.some((l) => l.tool.name === "generate_image")) {
        const lastUserMsg = [...modelMessages].reverse().find((m) => m.role === "user");
        const fallbackPrompt = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
        if (fallbackPrompt) {
          call = { name: "generate_image", arguments: { prompt: fallbackPrompt } };
        }
      }
      if (call) {
        const resolvedCall = call;
        pushStep("tool", `Calling tool "${resolvedCall.name}"`, "start", JSON.stringify(resolvedCall.arguments));
        const link = attachedTools.find((l) => l.tool.name === resolvedCall.name);
        let output: string;
        let toolError: string | undefined;
        try {
          output = link ? await executeTool(link.tool, resolvedCall.arguments, app.prisma, { userId, currentChatId: chatId }) : "";
          if (!link) toolError = `Tool "${resolvedCall.name}" is not attached to this chat.`;
        } catch (err) {
          output = "";
          toolError = err instanceof Error ? err.message : String(err);
          logEvent(app.prisma, "ERROR", "tool", `Tool "${resolvedCall.name}" failed: ${toolError}`, { chatId });
        }

        const resultContent = toolError ? `Error: ${toolError}` : output;
        pushStep(
          "tool",
          toolError ? `Tool "${resolvedCall.name}" failed` : `Tool "${resolvedCall.name}" completed`,
          toolError ? "error" : "done",
          resultContent
        );
        await app.prisma.message.create({
          data: {
            chatId,
            role: "TOOL",
            toolName: resolvedCall.name,
            content: JSON.stringify({ arguments: resolvedCall.arguments, result: resultContent }),
          },
        });
        reply.raw.write(
          `data: ${JSON.stringify({ tool: { name: resolvedCall.name, arguments: resolvedCall.arguments, result: resultContent } })}\n\n`
        );

        // generate_image is special-cased: the model must never be asked to
        // retype the result (it would mangle or hallucinate the image
        // markdown, as seen when models "imitate" the placeholder text
        // instead of emitting a real image). Its tool output — the
        // "![Generated image](url)" markdown itself — IS the final answer.
        if (resolvedCall.name === "generate_image" && !toolError) {
          full = resultContent;
          if (!continueTargetId) {
            reply.raw.write(
              `data: ${JSON.stringify({ token: resultContent, done: true, usage: { promptTokens, completionTokens } })}\n\n`
            );
          }
        } else if (chat.agentMode) {
          // Agent mode (own build — not a third-party product like
          // OpenClaw/OpenHands, just this platform's equivalent): let the
          // model chain several tool calls in one turn instead of the
          // normal one-call-then-answer limit, e.g. search → read a page →
          // write a file, without the user prompting each step. Runs the
          // extra rounds non-streamed (each is fast and just decides the
          // next action); only the final answer streams to the client, via
          // the normal streaming block further down.
          modelMessages.push(
            { role: "assistant", content: firstPass },
            { role: "system", content: `Tool "${resolvedCall.name}" returned: ${resultContent}` }
          );
          const agentResult = await runAgentLoop({
            app,
            chat,
            userId,
            chatId,
            modelMessages,
            attachedTools,
            genOptions,
            toolDetectNumPredict,
            pushStep,
            writeSse: (payload) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`),
          });
          promptTokens = agentResult.promptTokens ?? promptTokens;
          completionTokens = agentResult.completionTokens ?? completionTokens;
          if (agentResult.done) {
            full = agentResult.content;
            if (!continueTargetId) {
              reply.raw.write(
                `data: ${JSON.stringify({ token: agentResult.content, done: true, usage: { promptTokens, completionTokens } })}\n\n`
              );
            }
          }
          // else: agentResult left modelMessages ready for one more model
          // call (either it hit the step cap and told the model to wrap
          // up, or its last round wasn't a tool call and shouldn't be
          // re-run) — falls through to the normal streaming block below,
          // same as the single-tool-call path does.
        } else {
          modelMessages.push(
            { role: "assistant", content: firstPass },
            {
              role: "system",
              content: `Tool "${resolvedCall.name}" returned: ${resultContent}\n\nNow answer the user's original question using this result. Do not call another tool.`,
            }
          );
        }
      } else if (!full && /"tool_call"\s*:/.test(firstPass)) {
        // parseToolCall() couldn't make sense of this reply, but it clearly
        // *attempted* one (contains the marker key) — almost always a
        // truncated/malformed JSON blob (e.g. a dangling `{"tool_call":
        // {"name": "generate_image", ... "textures."}}` cut off before its
        // closing braces) rather than a genuine prose answer. Never leak
        // that raw fragment to the user — retry once, non-streamed, with
        // the broken attempt left out of context, so the model gets a
        // clean second shot instead.
        let retryContent = "";
        try {
          const providerModel = await resolveProviderModel(app.prisma, chat.model);
          const retryMessages = [
            ...modelMessages,
            {
              role: "system" as const,
              content:
                "Your previous reply was an incomplete tool_call JSON fragment and was discarded. Try again: either emit ONLY a complete, valid tool_call JSON object, or write a normal prose answer — never mix the two, never leave JSON unfinished.",
            },
          ];
          const retryResult = providerModel
            ? await chatOnceProvider(providerModel.config, {
                model: providerModel.modelName,
                messages: retryMessages,
                temperature: genOptions.temperature,
                top_p: genOptions.top_p,
                stop: genOptions.stop,
                num_predict: toolDetectNumPredict,
              })
            : await chatOnce({ model: chat.model, messages: retryMessages, ...genOptions, num_predict: toolDetectNumPredict });
          retryContent = scrubQwenMentions(retryResult.content);
          promptTokens = retryResult.promptTokens;
          completionTokens = retryResult.completionTokens;
        } catch (err) {
          reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
          reply.raw.end();
          return;
        }

        const retryCall = parseToolCall(retryContent);
        if (retryCall) {
          call = retryCall;
          firstPass = retryContent;
        } else if (/"tool_call"\s*:/.test(retryContent)) {
          // Still broken on the retry — give up gracefully rather than
          // ever showing raw JSON.
          full = "Sorry, er ging iets mis bij het genereren van dit antwoord. Probeer het opnieuw.";
          if (!continueTargetId) {
            reply.raw.write(
              `data: ${JSON.stringify({ token: full, done: true, usage: { promptTokens, completionTokens } })}\n\n`
            );
          }
        } else {
          full = retryContent;
          if (!continueTargetId) {
            reply.raw.write(
              `data: ${JSON.stringify({ token: retryContent, done: true, usage: { promptTokens, completionTokens } })}\n\n`
            );
          }
        }

        if (call && !full) {
          const resolvedCall = call;
          pushStep("tool", `Calling tool "${resolvedCall.name}"`, "start", JSON.stringify(resolvedCall.arguments));
          const link = attachedTools.find((l) => l.tool.name === resolvedCall.name);
          let output: string;
          let toolError: string | undefined;
          try {
            output = link ? await executeTool(link.tool, resolvedCall.arguments, app.prisma, { userId, currentChatId: chatId }) : "";
            if (!link) toolError = `Tool "${resolvedCall.name}" is not attached to this chat.`;
          } catch (err) {
            output = "";
            toolError = err instanceof Error ? err.message : String(err);
            logEvent(app.prisma, "ERROR", "tool", `Tool "${resolvedCall.name}" failed: ${toolError}`, { chatId });
          }
          const resultContent = toolError ? `Error: ${toolError}` : output;
          pushStep(
            "tool",
            toolError ? `Tool "${resolvedCall.name}" failed` : `Tool "${resolvedCall.name}" completed`,
            toolError ? "error" : "done",
            resultContent
          );
          await app.prisma.message.create({
            data: {
              chatId,
              role: "TOOL",
              toolName: resolvedCall.name,
              content: JSON.stringify({ arguments: resolvedCall.arguments, result: resultContent }),
            },
          });
          reply.raw.write(
            `data: ${JSON.stringify({ tool: { name: resolvedCall.name, arguments: resolvedCall.arguments, result: resultContent } })}\n\n`
          );
          if (resolvedCall.name === "generate_image" && !toolError) {
            full = resultContent;
            if (!continueTargetId) {
              reply.raw.write(
                `data: ${JSON.stringify({ token: resultContent, done: true, usage: { promptTokens, completionTokens } })}\n\n`
              );
            }
          } else {
            modelMessages.push(
              { role: "assistant", content: firstPass },
              {
                role: "system",
                content: `Tool "${resolvedCall.name}" returned: ${resultContent}\n\nNow answer the user's original question using this result. Do not call another tool.`,
              }
            );
          }
        }
      } else if (!full) {
        // No tool call, and no "tool_call" marker either — the "{" that
        // triggered buffering turned out to be unrelated to a tool call
        // (e.g. literal braces in ordinary prose). Any text before that
        // "{" was already streamed live above, so only flush what's still
        // withheld (toolCallBuffer) instead of re-sending firstPass in
        // full, which would duplicate that already-streamed prefix.
        full = firstPass;
        if (!continueTargetId) {
          reply.raw.write(
            `data: ${JSON.stringify({ token: toolCallBuffer, done: true, usage: { promptTokens, completionTokens } })}\n\n`
          );
        }
      }
    }

    // For a plain new message or a regenerate, tokens can stream straight
    // to the client as they arrive. For continueGeneration they can't —
    // Ollama has no real continuation mode (see lib/continuation.ts), so
    // the model frequently re-emits some or all of the previous message
    // before actually continuing. We can't un-send tokens that already
    // streamed, so for continue we buffer the whole reply, run it through
    // mergeContinuation once it's done, and only then emit the (deduped)
    // result — trading live streaming on this one path for not showing
    // the user a repeated answer.
    const bufferForDedup = !!continueTargetId;

    if (!full) {
      let reasoningStarted = false;
      try {
        const providerModel = await resolveProviderModel(app.prisma, chat.model);
        const chunks = providerModel
          ? streamProviderChat(providerModel.config, {
              model: providerModel.modelName,
              messages: modelMessages,
              temperature: genOptions.temperature,
              top_p: genOptions.top_p,
              stop: genOptions.stop,
              num_predict: genOptions.num_predict,
            })
          : streamChat({ model: chat.model, messages: modelMessages, ...genOptions });
        for await (const chunk of withStallTimeout(chunks)) {
          // Ollama fills either `thinking` or `content` per chunk, never
          // both — the model is either "in" its reasoning phase or its
          // answer phase at any given moment. Reasoning tokens stream as
          // their own SSE field so the client can render them in the
          // collapsible "Denken..." block instead of mixing them into the
          // visible reply.
          const reasoningToken = scrubQwenMentions(chunk.message?.thinking ?? "");
          if (reasoningToken) {
            if (!reasoningStarted) {
              reasoningStarted = true;
              pushStep("reasoning", "Thinking", "start");
            }
            reasoningFull += reasoningToken;
            reply.raw.write(`data: ${JSON.stringify({ reasoning: reasoningToken, done: false })}\n\n`);
          }

          const token = scrubQwenMentions(chunk.message?.content ?? "");
          full += token;
          if (chunk.done) {
            if (reasoningStarted) pushStep("reasoning", "Done thinking", "done");
            promptTokens = chunk.prompt_eval_count;
            completionTokens = chunk.eval_count;
            if (!bufferForDedup) {
              reply.raw.write(
                `data: ${JSON.stringify({ token, done: true, usage: { promptTokens, completionTokens } })}\n\n`
              );
            }
            break;
          }
          if (token && !bufferForDedup) reply.raw.write(`data: ${JSON.stringify({ token, done: false })}\n\n`);
        }
      } catch (err) {
        // The model connection dropped or errored mid-generation. `full`
        // may already hold everything streamed so far (e.g. most of a big
        // generated file) — previously this just wrote an `{error}` event
        // and fell through to the normal save-and-close path below, but
        // the client throws as soon as it sees `error` (see streamMessage
        // in lib/api.ts) and discards the whole reply, content included,
        // instead of continuing. If we already have something to show,
        // close out the stream as a normal (truncated) answer so the user
        // keeps what was generated; only surface a hard error when nothing
        // came back at all. Either way, end the response here — letting
        // execution continue past a broken connection is what caused the
        // "message disappears" / hangs behavior.
        if (full.trim()) {
          reply.raw.write(
            `data: ${JSON.stringify({ token: "", done: true, usage: { promptTokens, completionTokens } })}\n\n`
          );
        } else {
          reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
          reply.raw.end();
          return;
        }
      }
    }

    // Single dedup point for continueGeneration, covering all three ways
    // `full` can have been produced above (plain streaming, a pipe model,
    // or the non-streamed tool-call answer) — none of those wrote
    // anything to the client yet when continuing, precisely so this can
    // run first. See lib/continuation.ts for why this is needed at all.
    if (bufferForDedup && full.trim()) {
      const existingForDedup = await app.prisma.message.findUnique({ where: { id: continueTargetId! } });
      const merge = mergeContinuation(existingForDedup?.content ?? "", full);
      if (merge.droppedAsDuplicate) {
        pushStep(
          "reasoning",
          "Skipped a repeat",
          "done",
          "The model repeated the previous reply — nothing new was added."
        );
      }
      full = merge.text;
      reply.raw.write(
        `data: ${JSON.stringify({ token: full, done: true, usage: { promptTokens, completionTokens } })}\n\n`
      );
    } else if (bufferForDedup) {
      // Nothing came back at all (empty completion) — still close out the
      // stream so the client isn't left waiting on a "done" event.
      reply.raw.write(`data: ${JSON.stringify({ token: "", done: true, usage: { promptTokens, completionTokens } })}\n\n`);
    }

    if (full.trim()) {
      // Filters (outlet): same caveat as the POST pipeline below — the
      // reply is already streamed to the client over SSE, so an outlet
      // filter can't un-send tokens. What it CAN do is change what gets
      // persisted to history (e.g. redact before storage, append a
      // disclaimer, log to an external system) — that's still useful even
      // though the live stream already went out unfiltered.
      const outletResult = await runFilters(
        app.prisma,
        "outlet",
        chat.model,
        { content: full },
        { id: userId, email: (req.user as { email: string }).email, role: (req.user as { role: string }).role }
      );
      full = outletResult.body.content;

      // POST pipeline stage: the reply has already been streamed to the
      // client by this point (SSE doesn't allow un-sending tokens), so
      // POST rules can only FLAG for admin review, never BLOCK.
      const postResult = await runPipelines(app.prisma, "POST", full);
      if (postResult.outcome === "FLAG") {
        logEvent(app.prisma, "WARN", "pipeline", `Flagged assistant reply: ${postResult.reason}`, { chatId });
      }
      if (continueTargetId) {
        const existing = await app.prisma.message.findUnique({ where: { id: continueTargetId } });
        const existingSteps = Array.isArray(existing?.steps) ? (existing.steps as unknown as Step[]) : [];
        await app.prisma.message.update({
          where: { id: continueTargetId },
          data: {
            content: (existing?.content ?? "") + full,
            flagged: postResult.outcome === "FLAG" ? true : existing?.flagged,
            flagReason: postResult.outcome === "FLAG" ? postResult.reason : existing?.flagReason,
            completionTokens: (existing?.completionTokens ?? 0) + (completionTokens ?? 0),
            reasoning: [existing?.reasoning, reasoningFull].filter(Boolean).join("\n\n") || undefined,
            steps: [...existingSteps, ...steps] as unknown as object[],
          },
        });
        await app.prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
      } else {
        await app.prisma.message.create({
          data: {
            id: assistantMessageId,
            chatId,
            role: "ASSISTANT",
            content: full,
            flagged: postResult.outcome === "FLAG",
            flagReason: postResult.outcome === "FLAG" ? postResult.reason : undefined,
            model: chat.model,
            promptTokens,
            completionTokens,
            reasoning: reasoningFull || undefined,
            steps: steps.length > 0 ? (steps as unknown as object[]) : undefined,
          },
        });
        await recordTokenUsage(app.prisma, userId, (promptTokens ?? 0) + (completionTokens ?? 0));
        // Fire-and-forget: pull any new durable facts out of this exchange
        // (see lib/memory.ts). Never awaited — a slow or failed extraction
        // call must not delay or break the response already sent to the
        // client. Skipped for continueGeneration (nothing new was said).
        if (!body.continueGeneration) {
          extractAndSaveMemory(app.prisma, userId, chat.model, body.content, full).catch(() => {});
        }
        // Auto-title new chats from the first exchange
        if (chat.title === "New chat") {
          const title = body.content.slice(0, 60);
          await app.prisma.chat.update({ where: { id: chatId }, data: { title } });
        } else {
          await app.prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
        }
      }
    }

    reply.raw.end();
  });
}
