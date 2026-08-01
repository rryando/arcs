export interface MarkdownHeading {
  depth: number;
  text: string;
  id: string;
}

/**
 * A heading plus the source range it owns: everything from its own heading line
 * down to the next heading at the same or shallower depth (so subsections are
 * part of their parent). Text before the first heading belongs to no section.
 */
export interface MarkdownSection extends MarkdownHeading {
  /** Character index of the first `#` of the heading line. */
  startOffset: number;
  /** Character index one past the last character the section owns. */
  endOffset: number;
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

/** Single line scan shared by `extractHeadings` and `extractSections`. */
function scanHeadings(markdown: string): Array<{ depth: number; text: string; offset: number }> {
  const found: Array<{ depth: number; text: string; offset: number }> = [];
  let inFence = false;
  let offset = 0;

  for (const line of markdown.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1; // the "\n" consumed by split
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (match?.[1] && match[2]) {
      found.push({
        depth: match[1].length,
        text: match[2].replace(/[*_`]/g, ""),
        offset: lineStart,
      });
    }
  }

  return found;
}

export function extractHeadings(markdown: string): MarkdownHeading[] {
  const nextId = createHeadingIdGenerator();
  return scanHeadings(markdown).map(({ depth, text }) => ({ depth, text, id: nextId(text) }));
}

export function extractSections(markdown: string): MarkdownSection[] {
  const nextId = createHeadingIdGenerator();
  const found = scanHeadings(markdown);

  return found.map((heading, index) => {
    let endOffset = markdown.length;
    for (let next = index + 1; next < found.length; next++) {
      const candidate = found[next];
      if (candidate && candidate.depth <= heading.depth) {
        endOffset = candidate.offset;
        break;
      }
    }
    return {
      depth: heading.depth,
      text: heading.text,
      id: nextId(heading.text),
      startOffset: heading.offset,
      endOffset,
    };
  });
}
