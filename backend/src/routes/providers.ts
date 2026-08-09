import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { encryptSecret, decryptSecret, maskSecret } from "../lib/crypto.js";
import { testProviderConnection } from "../lib/providers.js";

const providerBody = z.object({
  name: z.string().min(1),
  type: z.enum(["openai", "anthropic", "openai_compatible"]),
  baseUrl: z.string().url().optional().nullable(),
  apiKey: z.string().min(1),
  models: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

// Partial update: apiKey is optional here — omitting it keeps the
// currently-stored key (so editing a provider's name doesn't force
// re-entering the key every time).
const providerUpdateBody = providerBody.partial().extend({
  apiKey: z.string().min(1).optional(),
});

function toPublic(provider: {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  apiKeyEncrypted: string;
  models: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastTestedAt: Date | null;
  lastTestError: string | null;
}) {
  let apiKeyPreview = "••••••••";
  try {
    apiKeyPreview = maskSecret(decryptSecret(provider.apiKeyEncrypted));
  } catch {
    // Leave the generic mask if decryption fails (e.g. key rotated) —
    // never throw just for a list view.
  }
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKeyPreview,
    models: provider.models,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    lastTestedAt: provider.lastTestedAt,
    lastTestError: provider.lastTestError,
  };
}

export default async function providersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  // ---- List ----
  app.get("/admin/providers", async () => {
    const providers = await app.prisma.aiProvider.findMany({ orderBy: { name: "asc" } });
    return { providers: providers.map(toPublic) };
  });

  // ---- Create ----
  app.post("/admin/providers", async (req, reply) => {
    const body = providerBody.parse(req.body);
    const existing = await app.prisma.aiProvider.findUnique({ where: { name: body.name } });
    if (existing) return reply.code(409).send({ error: "A provider with this name already exists" });
    const provider = await app.prisma.aiProvider.create({
      data: {
        name: body.name,
        type: body.type,
        baseUrl: body.baseUrl ?? null,
        apiKeyEncrypted: encryptSecret(body.apiKey),
        models: body.models ?? [],
        enabled: body.enabled ?? true,
      },
    });
    return { provider: toPublic(provider) };
  });

  // ---- Update ----
  app.patch("/admin/providers/:providerId", async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const body = providerUpdateBody.parse(req.body);
    const existing = await app.prisma.aiProvider.findUnique({ where: { id: providerId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const provider = await app.prisma.aiProvider.update({
      where: { id: providerId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey !== undefined ? { apiKeyEncrypted: encryptSecret(body.apiKey) } : {}),
        ...(body.models !== undefined ? { models: body.models } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    });
    return { provider: toPublic(provider) };
  });

  // ---- Delete ----
  app.delete("/admin/providers/:providerId", async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const existing = await app.prisma.aiProvider.findUnique({ where: { id: providerId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.aiProvider.delete({ where: { id: providerId } });
    return { ok: true };
  });

  // ---- Test connection: verifies the stored key works, and for
  // OpenAI/compatible providers auto-fills `models` from the provider's
  // own /models endpoint if the admin hasn't set any yet. ----
  app.post("/admin/providers/:providerId/test", async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const existing = await app.prisma.aiProvider.findUnique({ where: { id: providerId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    const result = await testProviderConnection({
      type: existing.type as "openai" | "anthropic" | "openai_compatible",
      apiKey: decryptSecret(existing.apiKeyEncrypted),
      baseUrl: existing.baseUrl,
    });

    const provider = await app.prisma.aiProvider.update({
      where: { id: providerId },
      data: {
        lastTestedAt: new Date(),
        lastTestError: result.ok ? null : result.error ?? "Unknown error",
        ...(result.ok && result.models?.length && existing.models.length === 0
          ? { models: result.models }
          : {}),
      },
    });
    return { ok: result.ok, error: result.error, provider: toPublic(provider) };
  });
}
