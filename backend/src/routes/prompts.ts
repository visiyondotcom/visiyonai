import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";

export default async function promptsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ---- List: own prompts + everything shared with all ----
  app.get("/prompts", async (req) => {
    const { id: userId } = req.user as { id: string };
    const prompts = await app.prisma.prompt.findMany({
      where: { OR: [{ userId }, { sharedWithAll: true }] },
      orderBy: [{ sharedWithAll: "desc" }, { updatedAt: "desc" }],
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return { prompts };
  });

  // ---- Create ----
  app.post("/prompts", async (req, reply) => {
    const { id: userId, role } = req.user as { id: string; role: string };
    const body = z
      .object({
        title: z.string().min(1),
        content: z.string().min(1),
        description: z.string().optional(),
        sharedWithAll: z.boolean().optional(),
      })
      .parse(req.body);

    if (body.sharedWithAll && role !== "ADMIN") {
      return reply.code(403).send({ error: "Only admins can share a prompt with everyone" });
    }

    const prompt = await app.prisma.prompt.create({
      data: { ...body, userId },
    });
    return { prompt };
  });

  // ---- Update ----
  app.patch("/prompts/:promptId", async (req, reply) => {
    const { id: userId, role } = req.user as { id: string; role: string };
    const { promptId } = req.params as { promptId: string };
    const body = z
      .object({
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        description: z.string().optional(),
        sharedWithAll: z.boolean().optional(),
      })
      .parse(req.body);

    const existing = await app.prisma.prompt.findUnique({ where: { id: promptId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    if (existing.userId !== userId && role !== "ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (body.sharedWithAll && role !== "ADMIN") {
      return reply.code(403).send({ error: "Only admins can share a prompt with everyone" });
    }

    const prompt = await app.prisma.prompt.update({ where: { id: promptId }, data: body });
    return { prompt };
  });

  // ---- Delete ----
  app.delete("/prompts/:promptId", async (req, reply) => {
    const { id: userId, role } = req.user as { id: string; role: string };
    const { promptId } = req.params as { promptId: string };
    const existing = await app.prisma.prompt.findUnique({ where: { id: promptId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    if (existing.userId !== userId && role !== "ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    await app.prisma.prompt.delete({ where: { id: promptId } });
    return { ok: true };
  });
}
