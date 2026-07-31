export interface MarkdownHeading {
  depth: number;
  text: string;
  id: string;
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

export function createHeadingIdGenerator(): (text: string) => string {
  const counts = new Map<string, number>();
  return (text: string) => {
    const base = slugifyHeading(text);
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    return next === 1 ? base : `${base}-${next}`;
  };
}

export function extractHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const nextId = createHeadingIdGenerator();
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (match?.[1] && match[2]) {
      const text = match[2].replace(/[*_`]/g, "");
      headings.push({ depth: match[1].length, text, id: nextId(text) });
    }
  }

  return headings;
}
