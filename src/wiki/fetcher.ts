import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { type WikiPage } from './types.js';

const DOCS_SUBDIR = 'docs';
const CACHE_DIR = 'data';

export async function ensureWikiClone(cloneUrl: string, clonePath: string): Promise<void> {
  const gitDir = path.join(clonePath, '.git');
  if (fs.existsSync(gitDir)) {
    // Only pull if it's been more than 1 hour since the last pull.
    const shouldPull = shouldPullWiki(clonePath);
    if (shouldPull) {
      try {
        await simpleGit(clonePath).pull();
        recordLastPull();
      } catch (err) {
        const msg = (err as Error).message;
        // Dubious ownership in Docker — delete and re-clone.
        if (msg.includes('dubious ownership')) {
          console.log('Wiki repo has dubious ownership — deleting and re-cloning...');
          fs.rmSync(clonePath, { recursive: true, force: true });
        } else {
          console.error(`Failed to pull wiki updates: ${msg}`);
          return;
        }
      }
    }
  }

  // Clone or re-clone.
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });
  try {
    await simpleGit().clone(cloneUrl, clonePath);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Authentication') || msg.includes('403') || msg.includes('401')) {
      console.error(`Failed to clone wiki: private repository or authentication required. Wiki search will be unavailable.`);
    } else {
      console.error(`Failed to clone wiki: ${msg}`);
    }
    throw err;
  }
}

function shouldPullWiki(clonePath: string): boolean {
  const lastPullPath = path.join(clonePath, '..', CACHE_DIR, 'wiki-last-pull.json');
  try {
    const raw = fs.readFileSync(lastPullPath, 'utf-8');
    const { timestamp } = JSON.parse(raw) as { timestamp: number };
    const now = Date.now();
    // Pull if last pull was more than 1 hour ago.
    return now - timestamp > 60 * 60 * 1000;
  } catch {
    // No record or invalid file — pull.
    return true;
  }
}

function recordLastPull(): void {
  const dir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lastPullPath = path.join(dir, 'wiki-last-pull.json');
  fs.writeFileSync(lastPullPath, JSON.stringify({ timestamp: Date.now() }), 'utf-8');
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
