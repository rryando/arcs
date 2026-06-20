// ---------------------------------------------------------------------------
// brief-renderer — Pure markdown renderer for arcs brief data
// ---------------------------------------------------------------------------

export interface BriefTask {
  id: string;
  title: string;
  status: string;
}

export interface BriefKnowledge {
  id: string;
  title: string;
  kind: string;
}

export interface BriefData {
  slug: string;
  name: string;
  summary: string;
  operatingBrief: {
    currentFocus: string;
    recommendedSurface: string;
    why: string;
    nextAction: string;
  };
  activePlansCount: number;
  activePlanTitles?: string[];
  openTasksCount: number;
  topOpenTasks?: BriefTask[];
  topKnowledge: BriefKnowledge[];
  knowledgeHealth?: { total: number; thin: number; stale: number };
}

/**
 * Renders a brief envelope's data payload as plain markdown.
 * No ANSI escapes, no box-drawing, no emoji — safe for OpenCode chat.
 */
export function renderBrief(data: BriefData): string {
  const lines: string[] = [];

  // Heading
  lines.push(`# ${data.name}`);
  lines.push("");

  // Summary
  if (data.summary) {
    lines.push(data.summary);
    lines.push("");
  }

  // Operating brief
  const ob = data.operatingBrief;
  lines.push(`**Focus:** ${ob.currentFocus}`);
  lines.push(`**Surface:** ${ob.recommendedSurface}`);
  lines.push(`**Why:** ${ob.why}`);
  lines.push(`**Next:** ${ob.nextAction}`);
  lines.push("");

  // Active Plans
  if (data.activePlansCount === 0) {
    lines.push("## Active Plans");
    lines.push("None active.");
  } else {
    lines.push(`## Active Plans (${data.activePlansCount})`);
    if (data.activePlanTitles && data.activePlanTitles.length > 0) {
      for (const title of data.activePlanTitles) {
        lines.push(`- ${title}`);
      }
    }
  }
  lines.push("");

  // Open Tasks
  if (data.openTasksCount === 0) {
    lines.push("## Open Tasks");
    lines.push("None open.");
  } else {
    lines.push(`## Open Tasks (${data.openTasksCount})`);
    if (data.topOpenTasks && data.topOpenTasks.length > 0) {
      for (const task of data.topOpenTasks) {
        const marker = task.status === "in_progress" ? "/" : " ";
        lines.push(`- [${marker}] ${task.title}`);
      }
      if (data.openTasksCount > data.topOpenTasks.length) {
        lines.push("- ...");
      }
    }
  }
  lines.push("");

  // Top Knowledge
  if (data.topKnowledge.length > 0) {
    lines.push("## Top Knowledge");
    for (const entry of data.topKnowledge) {
      lines.push(`- ${entry.title} (${entry.kind})`);
    }
    lines.push("");
  }

  // Knowledge Health — only surface when there is something to act on
  const kh = data.knowledgeHealth;
  if (kh && (kh.thin > 0 || kh.stale > 0)) {
    lines.push("## Knowledge Health");
    lines.push(`- ${kh.thin} thin, ${kh.stale} stale of ${kh.total} entries`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
