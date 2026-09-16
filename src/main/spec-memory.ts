import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RetrievedSpecChunk, SpecChunk, SpecDocument, SpecDocumentView } from "./types";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 2_000_000;
const TARGET_CHUNK_CHARS = 1_500;
const CHUNK_OVERLAP_CHARS = 180;
const MAX_CHUNKS_PER_DOCUMENT = 2_000;

export class SpecMemoryStore {
  private documents: SpecDocument[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.documents = Array.isArray(parsed) ? parsed.filter(isSpecDocument).slice(0, 100) : [];
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  list(): SpecDocumentView[] {
    return this.documents.map(({ id, name, hash, bytes, addedAt, chunkCount }) => ({ id, name, hash, bytes, addedAt, chunkCount }));
  }

  async addFiles(paths: string[]): Promise<SpecDocumentView[]> {
    const added: SpecDocumentView[] = [];
    for (const filePath of paths.slice(0, 20)) {
      const buffer = await readFile(filePath);
      if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error(`${path.basename(filePath)} exceeds the 10 MiB spec limit.`);
      const hash = createHash("sha256").update(buffer).digest("hex");
      const existing = this.documents.find((document) => document.hash === hash);
      if (existing) {
        added.push(toView(existing));
        continue;
      }
      const text = normalizeExtractedText(await extractText(filePath, buffer));
      if (!text.trim()) throw new Error(`${path.basename(filePath)} did not contain extractable text.`);
      const id = `spec_${hash.slice(0, 16)}`;
      const chunks = chunkText(id, path.basename(filePath), text);
      const document: SpecDocument = {
        id,
        name: path.basename(filePath),
        hash,
        bytes: buffer.byteLength,
        addedAt: new Date().toISOString(),
        chunkCount: chunks.length,
        chunks,
      };
      this.documents.unshift(document);
      this.documents = this.documents.slice(0, 100);
      added.push(toView(document));
    }
    await this.flush();
    return added;
  }

  async remove(id: string): Promise<void> {
    const before = this.documents.length;
    this.documents = this.documents.filter((document) => document.id !== id);
    if (this.documents.length !== before) await this.flush();
  }

  search(query: string, limit = 10): RetrievedSpecChunk[] {
    const allChunks = this.documents.flatMap((document) => document.chunks);
    if (!query.trim() || allChunks.length === 0) return [];
    const queryTerms = termFrequency(tokenize(query));
    if (Object.keys(queryTerms).length === 0) return [];

    const documentFrequency = new Map<string, number>();
    for (const chunk of allChunks) {
      for (const term of Object.keys(chunk.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    const averageLength = allChunks.reduce((sum, chunk) => sum + Object.values(chunk.terms).reduce((a, b) => a + b, 0), 0) / Math.max(1, allChunks.length);
    const scored = allChunks.map((chunk) => ({ chunk, score: bm25(chunk, queryTerms, documentFrequency, allChunks.length, averageLength, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const selected: RetrievedSpecChunk[] = [];
    const perDocument = new Map<string, number>();
    for (const item of scored) {
      if (selected.length >= Math.max(1, Math.min(limit, 20))) break;
      const count = perDocument.get(item.chunk.documentId) ?? 0;
      if (count >= 4) continue;
      perDocument.set(item.chunk.documentId, count + 1);
      selected.push({
        documentId: item.chunk.documentId,
        documentName: item.chunk.documentName,
        chunkId: item.chunk.id,
        score: Number(item.score.toFixed(4)),
        text: item.chunk.text,
      });
    }
    return selected;
  }

  private flush(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.documents, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    return this.writeChain;
  }
}

async function extractText(filePath: string, buffer: Buffer): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  if ([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".csv", ".ts", ".tsx", ".js", ".jsx", ".html", ".xml"].includes(extension)) {
    return buffer.toString("utf8");
  }
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (extension === ".pdf") {
    const module = await import("pdf-parse");
    const pdfParse = (module.default ?? module) as unknown as (input: Buffer) => Promise<{ text?: string }>;
    const result = await pdfParse(buffer);
    return result.text ?? "";
  }
  throw new Error(`Unsupported spec type: ${extension || "unknown"}. Use PDF, DOCX, Markdown, text, JSON, YAML or source text.`);
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .slice(0, MAX_EXTRACTED_CHARS);
}

function chunkText(documentId: string, documentName: string, text: string): SpecChunk[] {
  const sections = text.split(/(?=^#{1,6}\s+)|\n{2,}/m).map((part) => part.trim()).filter(Boolean);
  const chunks: SpecChunk[] = [];
  let buffer = "";
  const push = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    const index = chunks.length;
    chunks.push({
      id: `${documentId}:${index}`,
      documentId,
      documentName,
      index,
      text: normalized,
      terms: termFrequency(tokenize(normalized)),
    });
  };

  for (const section of sections) {
    if (section.length > TARGET_CHUNK_CHARS * 1.7) {
      if (buffer) {
        push(buffer);
        buffer = tail(buffer, CHUNK_OVERLAP_CHARS);
      }
      let cursor = 0;
      while (cursor < section.length && chunks.length < MAX_CHUNKS_PER_DOCUMENT) {
        const end = Math.min(section.length, cursor + TARGET_CHUNK_CHARS);
        push(section.slice(cursor, end));
        if (end >= section.length) break;
        cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP_CHARS);
      }
      continue;
    }
    const combined = buffer ? `${buffer}\n\n${section}` : section;
    if (combined.length > TARGET_CHUNK_CHARS && buffer) {
      push(buffer);
      buffer = `${tail(buffer, CHUNK_OVERLAP_CHARS)}\n\n${section}`;
    } else {
      buffer = combined;
    }
    if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) break;
  }
  if (buffer && chunks.length < MAX_CHUNKS_PER_DOCUMENT) push(buffer);
  return chunks;
}

function bm25(
  chunk: SpecChunk,
  queryTerms: Record<string, number>,
  documentFrequency: Map<string, number>,
  totalDocuments: number,
  averageLength: number,
  rawQuery: string,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const length = Object.values(chunk.terms).reduce((sum, value) => sum + value, 0);
  let score = 0;
  for (const [term, queryFrequency] of Object.entries(queryTerms)) {
    const frequency = chunk.terms[term] ?? 0;
    if (frequency === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));
    const normalized = frequency + k1 * (1 - b + b * length / Math.max(1, averageLength));
    score += idf * ((frequency * (k1 + 1)) / normalized) * Math.min(2, queryFrequency);
  }
  const jiraKeys = rawQuery.match(/\b[A-Z][A-Z0-9]{1,15}-\d+\b/g) ?? [];
  for (const key of jiraKeys) if (chunk.text.toUpperCase().includes(key.toUpperCase())) score += 4;
  return score;
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((term) => !STOP_WORDS.has(term));
}

function termFrequency(terms: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const term of terms) result[term] = (result[term] ?? 0) + 1;
  return result;
}

function tail(value: string, length: number): string {
  return value.slice(Math.max(0, value.length - length));
}

function toView(document: SpecDocument): SpecDocumentView {
  const { id, name, hash, bytes, addedAt, chunkCount } = document;
  return { id, name, hash, bytes, addedAt, chunkCount };
}

function isSpecDocument(value: unknown): value is SpecDocument {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.hash === "string"
    && typeof value.bytes === "number"
    && typeof value.addedAt === "string"
    && typeof value.chunkCount === "number"
    && Array.isArray(value.chunks)
    && value.chunks.every(isSpecChunk);
}

function isSpecChunk(value: unknown): value is SpecChunk {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.documentId === "string"
    && typeof value.documentName === "string"
    && typeof value.index === "number"
    && typeof value.text === "string"
    && isRecord(value.terms);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "are", "was", "were", "will", "shall", "should", "must",
  "các", "cho", "với", "của", "được", "trong", "khi", "thì", "và", "là", "một", "những", "này", "đó", "theo", "không",
]);
