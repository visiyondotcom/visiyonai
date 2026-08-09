import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../lib/jwt.js";
import { isValidSubdomain, isSafeRelativePath, writeSiteFiles, removeSite } from "../lib/sites.js";

// Used to build the full published URL returned to the frontend after a
// publish (e.g. "janspizza" -> https://janspizza.visiyon.com). Falls back
// to "localhost" for local/dev setups without a real domain configured.
const BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost";


// One static-site project per user — see prisma schema's Project model.
// All routes below operate on "the current user's project", creating it
// on first access (GET) so the frontend never has to special-case "no
// project yet" vs "empty project".

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024; // 512KB per file — plenty for hand-written HTML/CSS/JS
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5MB total per project

const filesSchema = z
  .record(z.string(), z.string())
  .refine((files) => Object.keys(files).length <= MAX_FILES, {
    message: `A project can have at most ${MAX_FILES} files.`,
  })
  .refine((files) => Object.entries(files).every(([p]) => isSafeRelativePath(p)), {
    message: "One or more file paths are invalid.",
  })
  .refine((files) => Object.values(files).every((c) => Buffer.byteLength(c, "utf-8") <= MAX_FILE_BYTES), {
    message: "One or more files are too large (max 512KB each).",
  })
  .refine(
    (files) => Object.values(files).reduce((sum, c) => sum + Buffer.byteLength(c, "utf-8"), 0) <= MAX_TOTAL_BYTES,
    { message: "Project is too large (max 5MB total)." }
  );

const DEFAULT_FILES: Record<string, string> = {
  "index.html": [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>My site</title>",
    '  <link rel="stylesheet" href="style.css" />',
    "</head>",
    "<body>",
    "  <h1>Hello world</h1>",
    '  <script src="script.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n"),
  "style.css": "body {\n  font-family: sans-serif;\n  margin: 2rem;\n}\n",
  "script.js": "console.log('Hello from script.js');\n",
};

export default async function studioRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  async function getOrCreateProject(userId: string) {
    const existing = await app.prisma.project.findUnique({ where: { userId } });
    if (existing) return existing;
    return app.prisma.project.create({ data: { userId, files: DEFAULT_FILES } });
  }

  app.get("/studio/project", async (req) => {
    const { id: userId } = req.user as { id: string };
    const project = await getOrCreateProject(userId);
    return { project };
  });

  app.put("/studio/project/files", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const parsed = filesSchema.safeParse((req.body as { files?: unknown })?.files);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message || "Invalid files" });
    }
    const project = await getOrCreateProject(userId);
    const updated = await app.prisma.project.update({
      where: { id: project.id },
      data: { files: parsed.data },
    });
    return { project: updated };
  });

  app.patch("/studio/project/subdomain", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const body = z.object({ subdomain: z.string().min(1).max(63) }).parse(req.body);
    const subdomain = body.subdomain.trim().toLowerCase();
    if (!isValidSubdomain(subdomain)) {
      return reply.code(400).send({
        error: "Invalid subdomain: use 3-63 lowercase letters, digits, or hyphens, and no reserved name.",
      });
    }
    const project = await getOrCreateProject(userId);
    const taken = await app.prisma.project.findUnique({ where: { subdomain } });
    if (taken && taken.userId !== userId) {
      return reply.code(409).send({ error: "This subdomain is already taken." });
    }
    const updated = await app.prisma.project.update({
      where: { id: project.id },
      data: { subdomain },
    });
    return { project: updated };
  });

  app.post("/studio/project/publish", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const project = await getOrCreateProject(userId);
    if (!project.subdomain) {
      return reply.code(400).send({ error: "Choose a subdomain before publishing." });
    }
    const files = (project.files as Record<string, string>) ?? {};
    try {
      await writeSiteFiles(project.subdomain, files);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "Publish failed" });
    }
    const updated = await app.prisma.project.update({
      where: { id: project.id },
      data: { publishedFiles: files, publishedAt: new Date() },
    });
    return { project: updated, url: `https://${project.subdomain}.${BASE_DOMAIN}` };
  });

  app.post("/studio/project/unpublish", async (req) => {
    const { id: userId } = req.user as { id: string };
    const project = await getOrCreateProject(userId);
    if (project.subdomain) await removeSite(project.subdomain);
    const updated = await app.prisma.project.update({
      where: { id: project.id },
      data: { publishedFiles: Prisma.JsonNull, publishedAt: null },
    });
    return { project: updated };
  });
}
