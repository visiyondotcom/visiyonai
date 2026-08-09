import type { FastifyInstance } from "fastify";
import { listModels, ollamaHealth } from "../lib/ollama.js";
import { requireAuth } from "../lib/jwt.js";
import { getAllowedModels } from "../lib/permissions.js";
import { safeDisplayName, scrubField } from "../lib/model-display.js";

// Embedding models (e.g. nomic-embed-text, pulled for document/RAG search —
// see lib/ollama.ts embedText) aren't chat models: they can't hold a
// conversation, so they must never show up in the model picker. Ollama's
// /api/tags has no field marking a model as "embedding-only", so this is
// matched two ways: (1) whatever's actually configured as EMBEDDING_MODEL,
// which catches it regardless of which specific model an admin pulled for
// embeddings, and (2) common embedding-model name patterns as a fallback
// for any additional embedding model that was pulled but never configured.
const EMBEDDING_MODEL_NAME = process.env.EMBEDDING_MODEL || "nomic-embed-text";
const EMBEDDING_NAME_PATTERN = /embed|bge-|minilm|e5-|gte-/i;

function stripTag(name: string): string {
  return name.split(":")[0];
}

export function isEmbeddingModel(name: string): boolean {
  if (stripTag(name) === stripTag(EMBEDDING_MODEL_NAME)) return true;
  return EMBEDDING_NAME_PATTERN.test(name);
}

export default async function modelsRoutes(app: FastifyInstance) {
  // Auto-detects every model pulled into Ollama — GLM-4-9B, Granite-4.1-8B,
  // Llama, Qwen, Gemma, DeepSeek, Mistral, Phi, vision models, etc.
  // No hardcoding: whatever `ollama pull <model>` has installed shows up here.
  // Results are then filtered down to whatever the caller's group is
  // allowed to use (admins and users with no/unrestricted group see all).
  app.get("/models", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    // Admin-configured display-name / hidden overrides, keyed by raw model
    // name (Ollama tag or "pipe:<slug>"). A model with no row here just
    // keeps its raw name and stays visible — see routes/admin.ts.
    const overrides = await app.prisma.modelSetting.findMany();
    const overrideByName = new Map(overrides.map((o) => [o.name, o]));

    // Enabled Pipes act as custom model providers — they show up in the
    // picker prefixed `pipe:<slug>` (see routes/chats.ts, which special-
    // cases that prefix instead of calling Ollama). Fetched regardless of
    // Ollama's reachability so a Pipe still works if Ollama itself is down.
    const pipes = await app.prisma.pipe.findMany({
      where: { enabled: true },
      select: { slug: true, name: true, description: true },
    });
    const pipeModels = pipes
      .map((p) => {
        const name = `pipe:${p.slug}`;
        const override = overrideByName.get(name);
        return {
          name,
          size: 0,
          modifiedAt: null,
          family: "pipe",
          parameterSize: null,
          quantization: null,
          displayName: override?.displayName ?? p.name,
          description: p.description,
          hidden: override?.hidden ?? false,
        };
      })
      .filter((m) => !m.hidden);

    // Enabled external AI providers (OpenAI, Anthropic/Claude, or any
    // OpenAI-compatible endpoint — see lib/providers.ts) contribute one
    // entry per configured model, named `provider:<providerId>:<model>` so
    // routes/chats.ts can route it to the right client without a lookup.
    const providers = await app.prisma.aiProvider.findMany({ where: { enabled: true } });
    const providerModels = providers
      .flatMap((p) =>
        p.models.map((modelName) => {
          const name = `provider:${p.id}:${modelName}`;
          const override = overrideByName.get(name);
          return {
            name,
            size: 0,
            modifiedAt: null,
            family: p.type,
            parameterSize: null,
            quantization: null,
            displayName: override?.displayName ?? `${p.name}: ${modelName}`,
            description: `Served via ${p.name} (${p.type})`,
            hidden: override?.hidden ?? false,
          };
        })
      )
      .filter((m) => !m.hidden);
    try {
      const models = await listModels();
      const { allowAll, models: allowedNames } = await getAllowedModels(app.prisma, userId);
      const chatCapable = models.filter((m) => !isEmbeddingModel(m.name));
      const filtered = allowAll ? chatCapable : chatCapable.filter((m) => allowedNames.includes(m.name));
      return {
        models: [
          ...filtered
            .map((m) => {
              const override = overrideByName.get(m.name);
              return {
                name: m.name,
                size: m.size,
                modifiedAt: m.modified_at,
                // family/parameterSize are raw Ollama metadata (e.g.
                // "qwen3.5") — scrubbed the same as the name itself so
                // nothing that leaks the underlying base model reaches a
                // non-admin. displayName always falls back to the scrubbed
                // name, never the raw tag, when no admin override exists.
                family: scrubField(m.details?.family),
                parameterSize: m.details?.parameter_size,
                quantization: m.details?.quantization_level,
                displayName: override?.displayName ?? safeDisplayName(m.name),
                hidden: override?.hidden ?? false,
              };
            })
            .filter((m) => !m.hidden),
          ...pipeModels,
          ...providerModels,
        ],
      };
    } catch (err) {
      if (pipeModels.length > 0 || providerModels.length > 0) {
        // Ollama being down shouldn't hide Pipes or external providers —
        // neither depends on it.
        return { models: [...pipeModels, ...providerModels] };
      }
      return reply.code(503).send({ error: "Ollama unreachable", detail: String(err) });
    }
  });

  app.get("/models/health", { preHandler: requireAuth }, async () => {
    const healthy = await ollamaHealth();
    return { healthy };
  });
}
