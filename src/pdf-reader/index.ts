import { existsSync } from 'fs';
import { extractPdfText } from './text-extractor.js';
import { extractMetadata } from './metadata.js';
import type { PdfReadInput, PdfReadOutput } from './types.js';

export type { PdfReadInput, PdfReadOutput, PdfPageContent, PdfMetadata } from './types.js';

/**
 * Read a PDF file and extract its text content.
 *
 * - Uses unpdf (modern PDF.js wrapper) for text extraction
 * - Detects scanned PDFs via character-count heuristic (computed against full document)
 * - Supports page ranges ("1-5", "3", "2,5,8-10")
 * - Optionally extracts metadata (title, author, etc.)
 */
export async function readPdf(input: PdfReadInput): Promise<PdfReadOutput> {
  const { filePath, pages, includeMetadata } = input;

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = await Bun.file(filePath).arrayBuffer();
  const buffer = new Uint8Array(fileBuffer);

  const { pages: pageContents, totalPages, isScanned, pdf } = await extractPdfText(buffer, pages);

  const text = pageContents.map(p => p.text).join('\n\n');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const charCount = text.length;

  let metadata;
  if (includeMetadata) {
    metadata = await extractMetadata(pdf);
  }

  return {
    text,
    pages: pageContents,
    totalPages,
    wordCount,
    charCount,
    metadata,
    isScanned,
    filePath,
  };
}
