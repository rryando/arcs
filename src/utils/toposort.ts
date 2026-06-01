/**
 * Topological sort utility using Kahn's algorithm.
 * Supports cycle detection and priority-based tiebreaking.
 */

export interface ToposortInput {
  id: string;
  dependsOn?: string[];
  priority?: "critical" | "high" | "medium" | "low";
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function priorityRank(p?: string): number {
  return p !== undefined ? (PRIORITY_RANK[p] ?? 2) : 2;
}

/**
 * Returns task IDs in valid topological order.
 * Uses priority as tiebreaker when multiple tasks have zero in-degree.
 * Throws if a cycle is detected.
 */
export function toposort(tasks: ToposortInput[]): string[] {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));

  // Build adjacency (id -> dependents) and in-degree maps
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // id -> tasks that depend on it

  for (const task of tasks) {
    if (!inDegree.has(task.id)) inDegree.set(task.id, 0);
    if (!dependents.has(task.id)) dependents.set(task.id, []);

    for (const dep of task.dependsOn ?? []) {
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      const depList = dependents.get(dep) ?? [];
      depList.push(task.id);
      dependents.set(dep, depList);
    }
  }

  // Initialize queue with zero-in-degree nodes sorted by priority
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  queue.sort(
    (a, b) => priorityRank(idToTask.get(a)?.priority) - priorityRank(idToTask.get(b)?.priority),
  );

  const result: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);

    const newReady: string[] = [];
    for (const dep of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) newReady.push(dep);
    }

    // Sort newly available nodes by priority before inserting
    newReady.sort(
      (a, b) => priorityRank(idToTask.get(a)?.priority) - priorityRank(idToTask.get(b)?.priority),
    );
    queue.push(...newReady);
    // Re-sort queue to maintain priority order
    queue.sort(
      (a, b) => priorityRank(idToTask.get(a)?.priority) - priorityRank(idToTask.get(b)?.priority),
    );
  }

  if (result.length < tasks.length) {
    const cycle = detectCycle(tasks);
    const cyclePath = cycle ? cycle.join(" → ") : "unknown";
    throw new Error(`Dependency cycle detected: ${cyclePath}`);
  }

  return result;
}

/**
 * Returns the cycle path (array of IDs) if a cycle exists, or null if acyclic.
 * Uses DFS with coloring to find the actual cycle.
 */
export function detectCycle(tasks: ToposortInput[]): string[] | null {
  const adjList = new Map<string, string[]>();
  for (const task of tasks) {
    adjList.set(task.id, task.dependsOn ?? []);
  }

  // white=0, gray=1 (in stack), black=2 (done)
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const task of tasks) {
    color.set(task.id, 0);
    parent.set(task.id, null);
  }

  let cycleStart: string | null = null;
  let cycleEnd: string | null = null;

  function dfs(id: string): boolean {
    color.set(id, 1);

    for (const dep of adjList.get(id) ?? []) {
      if (!color.has(dep)) {
        // dep not in our task list — skip
        continue;
      }
      if (color.get(dep) === 1) {
        // Found cycle
        cycleStart = dep;
        cycleEnd = id;
        return true;
      }
      if (color.get(dep) === 0) {
        parent.set(dep, id);
        if (dfs(dep)) return true;
      }
    }

    color.set(id, 2);
    return false;
  }

  for (const task of tasks) {
    if (color.get(task.id) === 0) {
      if (dfs(task.id)) break;
    }
  }

  if (cycleStart === null) return null;

  // Reconstruct cycle path: cycleEnd -> ... -> cycleStart
  const path: string[] = [];
  let cur: string | null = cycleEnd;
  while (cur !== null && cur !== cycleStart) {
    path.push(cur);
    cur = parent.get(cur) ?? null;
  }
  path.push(cycleStart);
  path.reverse();
  path.push(cycleStart); // close the loop

  return path;
}
