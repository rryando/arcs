/**
 * Completion-receipt panel — the evidence half of a finished task or plan.
 *
 * The task/plan meta carries only a POINTER (`meta.report`: commit, diffstat,
 * truncated flag, capturedAt). The receipt BODY — the capped unified diff, the
 * base/head shas, and, for a plan, the per-task attribution — is a sidecar read
 * from `GET /api/p/:slug/receipts/:id`. It is read once per mounted panel: only
 * the selected task's or the open plan's receipt is ever mounted, so the range
 * link can be offered straight away, and the diff itself still renders only
 * when the panel is expanded.
 *
 * The panel is shared by the tasks table (inline, under the table) and the plan
 * detail page, and it renders nothing but a line of chrome plus whatever the
 * caller's own receipt body contains. A caller with no receipt renders exactly
 * as it did before this panel existed — it only mounts when `meta.report` does.
 */

import { useState } from "react";
import type { StoredReceipt, TaskReportRef } from "../api/client";
import { useReceipt } from "../api/hooks";
import { formatDiffstat, formatPartialDiffstat, receiptLink, shortSha } from "../lib/evidence";
import { cx, relativeTime } from "../lib/format";
import { CodeBlock } from "./CodeBlock";

/** External links keep the document-viewer look: cyan, underlining on hover. */
const LINK_CLASS = "text-term-cyan underline underline-offset-2 hover:text-term-green";

export function ReceiptPanel({
  slug,
  /** Which area owns the receipt; keeps the query key under the area prefix so
   *  that area's change events invalidate it. */
  area,
  /** Task/plan id the receipt was stored under. */
  id,
  /** The persisted pointer. Its diffstat renders immediately; the diff and the
   *  plan's task attribution wait for the expand. */
  report,
  className,
}: {
  slug: string;
  area: "tasks" | "plans";
  id: string;
  report: TaskReportRef;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const receipt = useReceipt(slug, area, id);
  const body: StoredReceipt | undefined = receipt.data;
  const link = receiptLink(report, body);
  const truncated = report.truncated || body?.diffTruncated === true;
  const attribution = body?.taskAttribution ?? [];

  return (
    <section
      className={cx("border border-term-border bg-term-panel", className)}
      aria-label="completion receipt"
    >
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-[11px]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? "hide the captured diff" : "show the captured diff"}
          className="text-term-dim hover:text-term-green"
        >
          {open ? "▾" : "▸"} receipt
        </button>
        {report.commit && (
          <code className="text-term-amber" title={`head commit ${report.commit}`}>
            {shortSha(report.commit)}
          </code>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            title="open the captured change in the remote"
            className={LINK_CLASS}
          >
            open ↗
          </a>
        )}
        <span className="text-term-dim">{formatDiffstat(report)}</span>
        {truncated && (
          <span
            className="border border-term-amber/60 px-1 text-[10px] text-term-amber"
            title="the captured diff is capped at 300 lines / 12KB"
          >
            truncated
          </span>
        )}
        <span className="flex-1" />
        <span className="text-term-dim" title={report.capturedAt}>
          {relativeTime(report.capturedAt)}
        </span>
      </div>

      {open && (
        <div className="border-t border-term-border/60 p-2">
          {receipt.isLoading && <div className="text-[11px] text-term-dim">loading…</div>}
          {receipt.error && (
            <div className="text-[11px] text-term-red">
              receipt unavailable:{" "}
              {receipt.error instanceof Error ? receipt.error.message : String(receipt.error)}
            </div>
          )}
          {body && (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-term-dim">
                <span>base {shortSha(body.baseSha) || "—"}</span>
                <span>→</span>
                <span>head {shortSha(body.headSha) || "—"}</span>
                {body.baseRef && <span>since {body.baseRef}</span>}
                {body.branch && <span>on {body.branch}</span>}
              </div>

              {attribution.length > 0 && (
                <div className="mb-2 space-y-0.5 border-t border-term-border/40 pt-1">
                  <div className="text-[10px] tracking-wide text-term-dim uppercase">per task</div>
                  <ul className="space-y-0.5 text-[11px]">
                    {attribution.map((entry) => {
                      const stat = formatPartialDiffstat(entry);
                      return (
                        <li key={entry.taskId} className="flex flex-wrap items-center gap-2">
                          <span className="text-term-cyan" title={entry.taskId}>
                            {entry.taskId}
                          </span>
                          {entry.commit && (
                            <code className="text-term-amber">{shortSha(entry.commit)}</code>
                          )}
                          {stat && <span className="text-term-dim">{stat}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {body.diff.trim() === "" ? (
                <div className="text-[11px] text-term-dim">the receipt captured no diff</div>
              ) : (
                <CodeBlock
                  code={body.diff}
                  language="diff"
                  label={truncated ? "diff (truncated)" : "diff"}
                  maxHeightClass="max-h-96"
                />
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
