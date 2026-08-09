import type { PrismaClient } from "@prisma/client";
import { embedText } from "./ollama.js";

// ---- Text extraction ----

export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // txt, md, csv, and anything else plain-text-ish
  return buffer.toString("utf-8");
}

// ---- Chunking ----
// Character-based chunking with overlap. Simple and dependency-free;
// good enough for 8-9B context windows. Swap for a token-aware
// splitter later if you need tighter control over context budgets.
export function chunkText(text: string, chunkSize = 1200, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    chunks.push(clean.slice(start, end).trim());
    if (end === clean.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 20); // drop near-empty tail chunks
}

// ---- Ingestion pipeline ----
// Runs after upload: extract -> chunk -> embed -> store. Updates the
// Document's status as it progresses so the frontend can poll it.
export async function processDocument(
  prisma: PrismaClient,
  documentId: string,
  buffer: Buffer,
  mimeType: string
) {
  try {
    await prisma.document.update({ where: { id: documentId }, data: { status: "PROCESSING" } });

    const text = await extractText(buffer, mimeType);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await prisma.document.update({
        where: { id: documentId },
        data: { status: "FAILED", error: "No extractable text found in this file." },
      });
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i]);
      const vectorLiteral = `[${embedding.join(",")}]`;
      // Raw insert: Prisma can't write to an Unsupported("vector") column
      // through the normal client, so this goes straight to SQL.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "DocumentChunk" (id, "documentId", "chunkIndex", content, embedding, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4::vector, now())`,
        documentId,
        i,
        chunks[i],
        vectorLiteral
      );
    }

    await prisma.document.update({ where: { id: documentId }, data: { status: "READY" } });
  } catch (err) {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED", error: String(err).slice(0, 500) },
    });
  }
}

// ---- Retrieval ----
export interface RetrievedChunk {
  documentId: string;
  filename: string;
  content: string;
  similarity: number;
}

// Embeds the query, then finds the closest chunks (cosine distance via
// pgvector's <=> operator) among only the documents attached to this chat.
export async function retrieveRelevantChunks(
  prisma: PrismaClient,
  documentIds: string[],
  query: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  if (documentIds.length === 0) return [];

  const queryEmbedding = await embedText(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const rows = await prisma.$queryRawUnsafe<
    { documentId: string; filename: string; content: string; similarity: number }[]
  >(
    `SELECT dc."documentId" as "documentId", d.filename as filename, dc.content as content,
            1 - (dc.embedding <=> $1::vector) as similarity
     FROM "DocumentChunk" dc
     JOIN "Document" d ON d.id = dc."documentId"
     WHERE dc."documentId" = ANY($2::text[])
     ORDER BY dc.embedding <=> $1::vector
     LIMIT $3`,
    vectorLiteral,
    documentIds,
    topK
  );

  return rows;
}

// Formats retrieved chunks as a system-message block to prepend to the
// conversation sent to Ollama.
export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const sections = chunks
    .map((c, i) => `[Source ${i + 1}: ${c.filename}]\n${c.content}`)
    .join("\n\n");
  return `You have access to the following excerpts from documents the user has attached. Use them to answer if relevant, and mention which source you drew from. If the excerpts don't contain the answer, say so rather than guessing.\n\n${sections}`;
}
