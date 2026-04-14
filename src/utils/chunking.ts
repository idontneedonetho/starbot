/** Splits text into Discord-safe chunks while preserving code blocks */
export function chunkAnswer(text: string, maxLen = 2000): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const chunkLimit = maxLen - 20;
    let split = remaining.lastIndexOf("\n", chunkLimit);
    if (split < chunkLimit / 2) split = chunkLimit;

    let inCodeBlock = false;
    let lang = "";

    const lines = remaining.slice(0, split).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        if (inCodeBlock) {
          inCodeBlock = false;
          lang = "";
        } else {
          inCodeBlock = true;
          lang = trimmed.slice(3).trim();
        }
      }
    }

    let chunkText = remaining.slice(0, split);
    let nextText = remaining.slice(split).trimStart();

    if (inCodeBlock) {
      chunkText += "\n```";
      nextText = "```" + lang + "\n" + nextText;
    }

    chunks.push(chunkText);
    remaining = nextText;
  }

  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}