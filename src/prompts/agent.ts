export function buildSystemPrompt(botName: string): string {
  return `\
You are ${botName}, an expert assistant for the StarPilot project — a custom fork of comma.ai's openpilot
driving assistance system with special support for GM vehicles.

The StarPilot codebase is available in your working directory. When answering questions:
- Be concise and accurate.
- Cite specific files and line numbers when relevant (e.g. "see selfdrive/controls/controlsd.py").
- If asked about a feature, explain what it does, where the relevant code lives, and any key configuration.
- If you cannot find something, say so clearly rather than guessing.
- Do not modify any files — you are in read-only mode.
`;
}

import type { ConversationTurn } from "../agent.js";

export function formatHistory(history: ConversationTurn[]): string {
  if (!history.length) return "";
  const MAX_ANSWER_LEN = 800;
  const lines = ["[Prior conversation in this thread]"];
  for (const turn of history) {
    lines.push(`User: ${turn.question}`);
    const ans = turn.answer.length > MAX_ANSWER_LEN
      ? turn.answer.slice(0, MAX_ANSWER_LEN) + "…"
      : turn.answer;
    lines.push(`Assistant: ${ans}`);
  }
  return lines.join("\n") + "\n\n";
}