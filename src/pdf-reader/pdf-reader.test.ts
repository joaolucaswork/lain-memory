import { describe, test, expect } from 'bun:test';
import { parsePageRange } from './text-extractor.js';
import { readPdf } from './index.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('parsePageRange', () => {
  test('single page', () => {
    expect(parsePageRange('3', 10)).toEqual([2]);
  });

  test('page range', () => {
    expect(parsePageRange('1-5', 10)).toEqual([0, 1, 2, 3, 4]);
  });

  test('multiple ranges and pages', () => {
    expect(parsePageRange('2,5,8-10', 10)).toEqual([1, 4, 7, 8, 9]);
  });

  test('clamps to totalPages', () => {
    expect(parsePageRange('1-100', 5)).toEqual([0, 1, 2, 3, 4]);
  });

  test('ignores invalid pages', () => {
    expect(parsePageRange('0,-1,999', 5)).toEqual([]);
  });
});

describe('readPdf', () => {
  const testDir = join(import.meta.dir, '__test_fixtures__');
  const testPdfPath = join(testDir, 'test.pdf');

  // A minimal valid PDF with "Hello World" text
  const MINIMAL_PDF = Buffer.from(
    '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 100 700 Td (Hello World) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n0000000360 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n429\n%%EOF'
  );

  test('reads a valid PDF file', async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testPdfPath, MINIMAL_PDF);

    try {
      const result = await readPdf({ filePath: testPdfPath });
      expect(result.totalPages).toBe(1);
      expect(result.text).toContain('Hello World');
      // Minimal PDF has <50 chars/page, so heuristic flags it as scanned
      expect(result.isScanned).toBe(true);
      expect(result.filePath).toBe(testPdfPath);
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].pageNumber).toBe(1);
    } finally {
      unlinkSync(testPdfPath);
    }
  });

  test('throws for non-existent file', async () => {
    await expect(readPdf({ filePath: '/tmp/nonexistent.pdf' })).rejects.toThrow('File not found');
  });

  test('reads with metadata', async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testPdfPath, MINIMAL_PDF);

    try {
      const result = await readPdf({ filePath: testPdfPath, includeMetadata: true });
      expect(result.metadata).toBeDefined();
    } finally {
      unlinkSync(testPdfPath);
    }
  });
});
