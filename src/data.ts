import fs from 'fs';
import path from 'path';

const DATA_PATH = path.join(import.meta.dirname, '..', 'data', 'messages.json');

export interface StoredData {
  identificationMessageId: string | null;
  reportMessageId: string | null;
}

export function loadData(): StoredData {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { identificationMessageId: null, reportMessageId: null };
  }
}

export function saveData(data: StoredData): void {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
