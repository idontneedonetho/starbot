import fs from "fs";
import path from "path";
import { SESSION_DIR } from "./config.js";

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

export function getOrCreateSessionPath(threadId: string): string {
  ensureSessionDir();
  return path.join(SESSION_DIR, threadId);
}

export function deleteSession(threadId: string): void {
  const sessionDir = path.join(SESSION_DIR, threadId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`[memory] Deleted session for thread ${threadId}`);
  }
}
