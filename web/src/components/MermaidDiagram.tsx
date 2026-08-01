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
        background: "#1a1a1a",
        primaryColor: "#101010",
        primaryBorderColor: "#474747",
        primaryTextColor: "#f2f2f2",
        lineColor: "#8f8f8f",
        secondaryColor: "#101010",
        tertiaryColor: "#050505",
        mainBkg: "#101010",
        nodeBorder: "#474747",
        clusterBkg: "#050505",
        edgeLabelBackground: "#101010",
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
