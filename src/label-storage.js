import fs from 'node:fs/promises';
import path from 'node:path';
import { labelsPublicDir, publicBaseUrl, resolvePublicBaseUrl } from './config.js';

export function labelsDirectory() {
  return labelsPublicDir();
}

/**
 * @param {string} fileName
 * @param {string} [baseUrlOverride]
 */
export function labelPublicUrl(fileName, baseUrlOverride) {
  const base = (baseUrlOverride || publicBaseUrl()).replace(/\/$/, '');
  return `${base}/labels/${fileName}`;
}

export async function ensureLabelsDirectory() {
  const dir = labelsDirectory();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** @param {string} fileName @param {Buffer} pdfBytes @param {{ publicBaseUrl?: string, forwardHeaders?: Record<string, string|undefined> }} [opts] */
export async function saveLabelPdf(fileName, pdfBytes, opts = {}) {
  const dir = await ensureLabelsDirectory();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, safeName);
  await fs.writeFile(filePath, pdfBytes);
  const base =
    opts.publicBaseUrl ||
    resolvePublicBaseUrl(opts.forwardHeaders || {});
  return labelPublicUrl(safeName, base);
}
