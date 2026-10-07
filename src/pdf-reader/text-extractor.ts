import { getDocumentProxy, extractText } from 'unpdf';
import type { PdfPageContent } from './types.js';

/** Minimum average chars/page to consider a PDF text-based (not scanned) */
const SCANNED_THRESHOLD = 50;

/**
 * Parse a page range string into an array of 0-based page indices.
 * Supports: "3" → [2], "1-5" → [0,1,2,3,4], "2,5,8-10" → [1,4,7,8,9]
 */
export function parsePageRange(range: string, totalPages: number): number[] {
  const indices: Set<number> = new Set();
  const parts = range.split(',').map(s => s.trim());

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = Math.max(1, parseInt(startStr, 10));
      const end = Math.min(totalPages, parseInt(endStr, 10));
      for (let i = start; i <= end; i++) indices.add(i - 1);
    } else {
      const page = parseInt(part, 10);
      if (page >= 1 && page <= totalPages) indices.add(page - 1);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Extract text from a PDF buffer using unpdf.
 * Returns per-page content and scanned detection.
 */
export async function extractPdfText(
  buffer: Uint8Array,
  pageRange?: string,
): Promise<{ pages: PdfPageContent[]; totalPages: number; isScanned: boolean; pdf: any }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const totalPages = pdf.numPages;

  const result = await extractText(pdf, { mergePages: false });
  const allPageTexts = result.text as string[];

  const indices = pageRange
    ? parsePageRange(pageRange, totalPages)
    : Array.from({ length: totalPages }, (_, i) => i);

  const pages: PdfPageContent[] = indices.map(i => ({
    pageNumber: i + 1,
    text: (allPageTexts[i] || '').trim(),
  }));

  // Detect if PDF is scanned (very few chars per page on average)
  const totalChars = allPageTexts.reduce((sum, t) => sum + t.trim().length, 0);
  const avgCharsPerPage = totalPages > 0 ? totalChars / totalPages : 0;
  const isScanned = avgCharsPerPage < SCANNED_THRESHOLD;

  return { pages, totalPages, isScanned, pdf };
}
