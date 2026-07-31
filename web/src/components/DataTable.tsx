/**
 * Dense, keyboard-navigable data table.
 *
 * Registers its own j/k (and enter) shortcuts while mounted. Selection is
 * shown as an inverted row with a ▸ marker — terminal-style.
 */

import { type ReactNode, useMemo, useState } from "react";
import { useShortcuts } from "../hooks/useShortcuts";
import { cx } from "../lib/format";
import type { Binding } from "../lib/shortcuts";

export interface Column<T> {
  key: string;
  title: string;
  className?: string;
  render: (row: T, index: number) => ReactNode;
  sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  onDelete?: (row: T) => void;
  emptyMessage?: string;
  /** Extra key bindings, e.g. [["s", cycleStatus], ["e", edit]]. */
  rowActions?: Array<{ keys: string; description: string; run: (row: T) => void }>;
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onOpen,
  onDelete,
  emptyMessage = "no entries",
  rowActions = [],
  selectedKey,
  onSelectedKeyChange,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [internalSelected, setInternalSelected] = useState(0);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const value = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, sortKey, sortAsc, columns]);

  const requestedIndex =
    selectedKey != null
      ? Math.max(
          0,
          sorted.findIndex((r) => rowKey(r) === selectedKey),
        )
      : internalSelected;
  const selectedIndex =
    sorted.length === 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, requestedIndex));

  const clamp = (n: number) => Math.max(0, Math.min(sorted.length - 1, n));

  const setSelected = (n: number) => {
    const next = clamp(n);
    if (onSelectedKeyChange) {
      onSelectedKeyChange(sorted[next] ? rowKey(sorted[next]) : null);
    } else {
      setInternalSelected(next);
    }
  };

  const selectedRow = sorted[selectedIndex];

  const bindings: Binding[] = [
    {
      keys: "j",
      description: "move down",
      group: "lists",
      priority: 10,
      run: () => setSelected(selectedIndex + 1),
    },
    {
      keys: "down",
      description: "move down",
      group: "lists",
      priority: 10,
      run: () => setSelected(selectedIndex + 1),
    },
    {
      keys: "k",
      description: "move up",
      group: "lists",
      priority: 10,
      run: () => setSelected(selectedIndex - 1),
    },
    {
      keys: "up",
      description: "move up",
      group: "lists",
      priority: 10,
      run: () => setSelected(selectedIndex - 1),
    },
    {
      keys: "home",
      description: "first row",
      group: "lists",
      priority: 10,
      run: () => setSelected(0),
    },
    {
      keys: "end",
      description: "last row",
      group: "lists",
      priority: 10,
      run: () => setSelected(sorted.length - 1),
    },
  ];
  if (onOpen && selectedRow) {
    bindings.push({
      keys: "enter",
      description: "open",
      group: "lists",
      priority: 10,
      run: () => onOpen(selectedRow),
    });
  }
  if (onDelete && selectedRow) {
    bindings.push({
      keys: "x",
      description: "delete",
      group: "lists",
      priority: 10,
      run: () => onDelete(selectedRow),
    });
  }
  for (const action of rowActions) {
    if (selectedRow) {
      bindings.push({
        keys: action.keys,
        description: action.description,
        group: "lists",
        priority: 10,
        run: () => action.run(selectedRow),
      });
    }
  }

  useShortcuts(bindings);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  if (sorted.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-term-dim">
        <span className="text-term-border-hi">∅</span> {emptyMessage}
      </div>
    );
  }

  return (
    <table className="w-full border-collapse text-[12px]">
      <thead className="sticky top-0 z-10 bg-term-panel">
        <tr className="border-b border-term-border text-left">
          <th className="w-6 px-1 py-1" />
          {columns.map((col) => (
            <th
              key={col.key}
              className={cx(
                "px-2 py-1 font-bold tracking-wide text-term-dim uppercase select-none",
                col.sortValue && "cursor-pointer hover:text-term-green",
                col.className,
              )}
              onClick={col.sortValue ? () => toggleSort(col.key) : undefined}
            >
              {col.title}
              {sortKey === col.key && (
                <span className="ml-1 text-term-green">{sortAsc ? "▲" : "▼"}</span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => {
          const isSelected = i === selectedIndex;
          return (
            <tr
              key={rowKey(row)}
              className={cx(
                "cursor-pointer border-b border-term-border/40",
                isSelected ? "bg-term-green text-term-bg" : "hover:bg-term-fg/5",
              )}
              onMouseEnter={() => setSelected(i)}
              onClick={() => onOpen?.(row)}
            >
              <td className={cx("px-1 py-0.5", isSelected ? "text-term-bg" : "text-term-green")}>
                {isSelected ? "▸" : ""}
              </td>
              {columns.map((col) => (
                <td key={col.key} className={cx("px-2 py-0.5", col.className)}>
                  {col.render(row, i)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
