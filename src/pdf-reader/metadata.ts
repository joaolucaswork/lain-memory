import type { PdfMetadata } from './types.js';

/**
 * Extract metadata from a PDF document proxy.
 * The proxy is obtained from unpdf's getDocumentProxy().
 */
export async function extractMetadata(pdf: any): Promise<PdfMetadata> {
  try {
    const meta = await pdf.getMetadata();
    const info = meta?.info as Record<string, any> | undefined;
    if (!info) return {};

    return {
      title: info.Title || undefined,
      author: info.Author || undefined,
      subject: info.Subject || undefined,
      creator: info.Creator || undefined,
      producer: info.Producer || undefined,
      creationDate: info.CreationDate || undefined,
      modificationDate: info.ModDate || undefined,
    };
  } catch {
    return {};
  }
}
