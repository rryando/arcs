/**
 * Mermaid diagram renderer (plan .diagram.mmd files).
 * Mermaid is loaded lazily — it's far too heavy for the main bundle.
 */

import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let initialized = false;
let renderSeq = 0;

async function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidPromise ??= import("mermaid");
  const mermaid = await mermaidPromise;
  if (!initialized) {
    initialized = true;
    mermaid.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "JetBrains Mono Variable, monospace",
      themeVariables: {
        background: "#060806",
        primaryColor: "#0b100b",
        primaryBorderColor: "#3a5340",
        primaryTextColor: "#b9dcb9",
        lineColor: "#647c66",
        secondaryColor: "#0b100b",
        tertiaryColor: "#070a07",
        mainBkg: "#0b100b",
        nodeBorder: "#3a5340",
        clusterBkg: "#070a07",
        edgeLabelBackground: "#0b100b",
        fontSize: "13px",
      },
    });
  }
  return mermaid;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${++renderSeq}`);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadMermaid()
      .then((mermaid) => mermaid.default.render(idRef.current, chart))
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  useEffect(() => {
    if (!svg || !containerRef.current) return;
    const fragment = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      RETURN_DOM_FRAGMENT: true,
    });
    containerRef.current.replaceChildren(fragment);
  }, [svg]);

  if (error) {
    return (
      <div className="border border-term-red/40 p-3 text-[12px] text-term-red">
        mermaid render error: {error}
        <pre className="mt-2 overflow-x-auto text-term-dim">{chart}</pre>
      </div>
    );
  }
  if (!svg) {
    return <div className="p-3 text-term-dim">rendering diagram…</div>;
  }
  return <div ref={containerRef} className="mmd overflow-x-auto p-2" />;
}
