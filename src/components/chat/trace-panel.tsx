"use client";

/**
 * TracePanel — renders the LangGraph execution trace from the most
 * recent /api/chat turn. Shows every node that ran, every tool that
 * was called, and how long each step took.
 *
 * The trace is purely informational — it helps the user (and the
 * developer) see exactly which graph (LeadCaptureGraph vs ChatGraph)
 * handled the turn and which nodes/tools executed.
 */

import type {
  GraphTrace,
  NodeTrace,
  ToolTrace,
} from "@/lib/graphs/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock,
  Wrench,
  XCircle,
} from "lucide-react";

interface TracePanelProps {
  trace: GraphTrace | null;
  isStreaming: boolean;
}

export function TracePanel({ trace, isStreaming }: TracePanelProps) {
  return (
    <Card className="flex h-full flex-col overflow-hidden border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/50">
      <CardHeader className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-emerald-600" />
          LangGraph Trace
          {isStreaming && (
            <Badge
              variant="secondary"
              className="ml-auto animate-pulse bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
            >
              streaming
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-full">
          {!trace ? (
            <EmptyState />
          ) : (
            <div className="space-y-4 p-4">
              <GraphHeader trace={trace} />

              <Separator />

              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  <Boxes className="h-3.5 w-3.5" />
                  Nodes ({trace.nodes.length})
                </h3>
                <ol className="space-y-1.5">
                  {trace.nodes.map((n, i) => (
                    <NodeRow key={`${n.name}-${i}`} node={n} index={i} />
                  ))}
                </ol>
              </section>

              {trace.tools.length > 0 && (
                <>
                  <Separator />
                  <section>
                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      <Wrench className="h-3.5 w-3.5" />
                      Tools ({trace.tools.length})
                    </h3>
                    <ol className="space-y-1.5">
                      {trace.tools.map((t, i) => (
                        <ToolRow key={`${t.name}-${i}`} tool={t} />
                      ))}
                    </ol>
                  </section>
                </>
              )}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Activity className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No graph runs yet.
      </p>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Send a message — the LeadCaptureGraph or ChatGraph trace will
        appear here in real time.
      </p>
    </div>
  );
}

function GraphHeader({ trace }: { trace: GraphTrace }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={
            "font-mono text-[11px] " +
            (trace.graphName === "LeadCaptureGraph"
              ? "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-300"
              : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300")
          }
        >
          {trace.graphName}
        </Badge>
        <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          <Clock className="h-3 w-3" />
          {(trace.durationMs / 1000).toFixed(2)}s
        </span>
      </div>
    </div>
  );
}

function NodeRow({ node, index }: { node: NodeTrace; index: number }) {
  return (
    <li className="flex items-start gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-100 px-1 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <code className="font-mono text-[12px] font-medium text-zinc-900 dark:text-zinc-100">
            {node.name}
          </code>
          <ArrowRight className="h-3 w-3 text-zinc-300 dark:text-zinc-700" />
        </div>
        {node.summary && (
          <p className="mt-0.5 break-words text-[11px] text-zinc-500 dark:text-zinc-400">
            {node.summary}
          </p>
        )}
      </div>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
        {node.durationMs}ms
      </span>
    </li>
  );
}

function ToolRow({ tool }: { tool: ToolTrace }) {
  return (
    <li className="flex items-start gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      {tool.ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
      ) : (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
      )}
      <div className="flex-1 min-w-0">
        <code className="font-mono text-[12px] font-medium text-zinc-900 dark:text-zinc-100">
          {tool.name}
        </code>
        {tool.summary && (
          <p className="mt-0.5 break-words text-[11px] text-zinc-500 dark:text-zinc-400">
            {tool.summary}
          </p>
        )}
      </div>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
        {tool.durationMs}ms
      </span>
    </li>
  );
}
