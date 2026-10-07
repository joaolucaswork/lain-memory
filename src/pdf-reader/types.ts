export interface PdfReadInput {
  filePath: string;
  /** Page range: "1-5", "3", "10-20". Omit for all pages. */
  pages?: string;
  /** Whether to include PDF metadata (title, author, etc.) */
  includeMetadata?: boolean;
}

export interface PdfPageContent {
  pageNumber: number;
  text: string;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export interface PdfReadOutput {
  text: string;
  pages: PdfPageContent[];
  totalPages: number;
  wordCount: number;
  charCount: number;
  metadata?: PdfMetadata;
  isScanned: boolean;
  filePath: string;
}
