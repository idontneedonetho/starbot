export function parseJsonArrayFromLLM<T>(raw: string): T[] {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((f): f is T => typeof f === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export function buildCompressPrompt(facts: string[]): string {
  return `Facts:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}