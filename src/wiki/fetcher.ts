import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { type WikiPage } from './types.js';

const DOCS_SUBDIR = 'docs';

export async function ensureWikiClone(cloneUrl: string, clonePath: string): Promise<void> {
  if (fs.existsSync(path.join(clonePath, '.git'))) {
    await simpleGit(clonePath).pull();
  } else {
    fs.mkdirSync(clonePath, { recursive: true });
    await simpleGit().clone(cloneUrl, clonePath);
  }
}

export function readWikiPages(clonePath: string): WikiPage[] {
  const docsDir = path.join(clonePath, DOCS_SUBDIR);
  const pages: WikiPage[] = [];
  if (!fs.existsSync(docsDir)) return pages;

  const files = walkMdFiles(docsDir);
  for (const file of files) {
    const filePath = path.join(docsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const title = extractTitle(content, path.basename(file));
    const url = pageUrl(file);
    pages.push({ title, content, path: file, url });
  }

  return pages;
}

function walkMdFiles(dir: string, relative = ''): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkMdFiles(full, rel));
    } else if (entry.name.endsWith('.md')) {
      files.push(rel);
    }
  }
  return files;
}

function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  return filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');
}

function pageUrl(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.md$/, '');
  const cleaned = withoutExt.replace(/\/?index$/, '');
  const suffix = cleaned ? `${cleaned}/` : '';
  return `https://wiki.firestar.link/${suffix}`;
}
