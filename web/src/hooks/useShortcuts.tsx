/**
 * Global keyboard shortcut provider.
 *
 * Views register bindings with useShortcuts(); the provider owns the single
 * window keydown listener and the sequence buffer (for "g k"-style chords).
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Binding, eventToKey, isEditableTarget, matchBindings } from "../lib/shortcuts";

const SEQUENCE_WINDOW_MS = 900;

interface ShortcutContextValue {
  register: (bindings: Binding[]) => () => void;
  listBindings: () => Binding[];
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef(new Map<number, Binding[]>());
  const nextIdRef = useRef(1);
  const bufferRef = useRef<{ keys: string[]; at: number }>({ keys: [], at: 0 });
  const [, forceRender] = useState(0);

  const register = useCallback((bindings: Binding[]) => {
    const id = nextIdRef.current++;
    registryRef.current.set(id, bindings);
    forceRender((n) => n + 1);
    return () => {
      registryRef.current.delete(id);
      forceRender((n) => n + 1);
    };
  }, []);

  const listBindings = useCallback(() => [...registryRef.current.values()].flat(), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = eventToKey(e);
      if (!key) return;

      const now = Date.now();
      const stale = now - bufferRef.current.at > SEQUENCE_WINDOW_MS;
      const base = stale ? [] : bufferRef.current.keys;
      const buffer = [...base, key];

      const editable = isEditableTarget(e.target);
      const candidates = [...registryRef.current.values()]
        .flat()
        .filter((b) => !editable || b.allowInInput);

      const result = matchBindings(candidates, buffer);

      if (result.kind === "matched") {
        e.preventDefault();
        e.stopPropagation();
        bufferRef.current = { keys: [], at: 0 };
        result.binding.run();
        return;
      }
      if (result.kind === "partial") {
        e.preventDefault();
        bufferRef.current = { keys: buffer, at: now };
        return;
      }
      bufferRef.current = { keys: [], at: 0 };
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ register, listBindings }), [register, listBindings]);
  return <ShortcutContext.Provider value={value}>{children}</ShortcutContext.Provider>;
}

function useShortcutContext(): ShortcutContextValue {
  const ctx = useContext(ShortcutContext);
  if (!ctx) throw new Error("useShortcuts must be used inside ShortcutsProvider");
  return ctx;
}

/**
 * Registers bindings for the lifetime of the calling component.
 * Bindings are re-registered when their identities change — wrap `run`
 * callbacks in useCallback or pass a fresh array each render (cheap either way).
 */
export function useShortcuts(bindings: Binding[]): void {
  const { register } = useShortcutContext();
  useEffect(() => register(bindings), [register, bindings]);
}

/** All currently registered bindings (for the help overlay). */
export function useRegisteredBindings(): Binding[] {
  const { listBindings } = useShortcutContext();
  return listBindings();
}
