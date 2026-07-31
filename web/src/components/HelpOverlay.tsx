/**
 * Help overlay — lists every currently registered shortcut, grouped.
 */

import { useMemo } from "react";
import { useRegisteredBindings } from "../hooks/useShortcuts";
import { Dialog } from "./Dialog";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const bindings = useRegisteredBindings();

  const groups = useMemo(() => {
    const map = new Map<string, typeof bindings>();
    for (const b of bindings) {
      const group = b.group ?? "global";
      const list = map.get(group) ?? [];
      if (!list.some((x) => x.keys === b.keys && x.description === b.description)) list.push(b);
      map.set(group, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [bindings]);

  return (
    <Dialog title="keyboard shortcuts" onClose={onClose} width="max-w-xl">
      <div className="grid max-h-[55vh] grid-cols-2 gap-x-6 gap-y-3 overflow-y-auto">
        {groups.map(([group, list]) => (
          <div key={group}>
            <div className="mb-1 border-b border-term-border pb-0.5 text-[10px] tracking-wide text-term-green uppercase">
              {group}
            </div>
            {list.map((b) => (
              <div
                key={`${group}:${b.keys}:${b.description}`}
                className="flex items-center justify-between py-0.5 text-[12px]"
              >
                <span className="text-term-dim">{b.description}</span>
                <span className="kbd ml-2">{b.keys}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
