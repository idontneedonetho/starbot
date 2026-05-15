import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'messages.json');

export interface PendingRouteData {
  dongleId: string;
  routeName: string;
  iteration?: string;
  userId: string;
}

export interface StoredData {
  identificationMessageId: string | null;
  reportThreadId: string | null;
  ticketCounter: number;
  pendingRoutes: Record<string, PendingRouteData>;
}

export function loadData(): StoredData {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      identificationMessageId: parsed.identificationMessageId ?? null,
      reportThreadId: parsed.reportThreadId ?? null,
      ticketCounter: parsed.ticketCounter ?? 0,
      pendingRoutes: parsed.pendingRoutes ?? {},
    };
  } catch {
    return { identificationMessageId: null, reportThreadId: null, ticketCounter: 0, pendingRoutes: {} };
  }
}

export function saveData(data: StoredData): void {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = DATA_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, DATA_PATH);
}

export function getNextTicketNumber(data: StoredData): { data: StoredData; ticketNumber: number } {
  data.ticketCounter += 1;
  saveData(data);
  return { data, ticketNumber: data.ticketCounter };
}
