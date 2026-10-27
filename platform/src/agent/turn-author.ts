import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

export interface TurnAuthor { id: string; name: string }
type Row = Record<string, unknown>;
type Query = (sql: string, bindings: readonly unknown[]) => Promise<readonly Row[]>;

/** Reads through the cell's shared SQL client, including its transaction semaphore. */
export function authorQuery(client: unknown): Query {
  return (sql, bindings) => Effect.runPromise((client as SqlClient).unsafe<Row>(sql, bindings));
}

async function runAuthor(runId: unknown, query: Query): Promise<TurnAuthor | undefined> {
  const messages = await query(`WITH RECURSIVE ancestors(run_id,thread_id,task_id,depth) AS (
    SELECT run_id,thread_id,json_extract(payload_json,'$.delegatedTaskId'),0 FROM orchestration_v2_projection_runs WHERE run_id=?
    UNION ALL
    SELECT r.run_id,r.thread_id,json_extract(r.payload_json,'$.delegatedTaskId'),a.depth+1 FROM ancestors a
      JOIN orchestration_v2_projection_subagents s ON s.child_thread_id=a.thread_id AND (a.task_id IS NULL OR a.task_id=s.subagent_id)
      JOIN orchestration_v2_projection_runs r ON r.run_id=s.run_id WHERE a.depth<32
    ) SELECT m.payload_json AS message FROM ancestors a
      JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id
      JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId')
      ORDER BY a.depth`, [runId]);
  for (const row of messages) {
    const message = JSON.parse(row.message as string) as { author?: TurnAuthor; scheduledTaskId?: string };
    if (message.author?.id) return message.author;
    if (message.scheduledTaskId) {
      const task = await query("SELECT author_json FROM scheduled_tasks WHERE task_id=?", [message.scheduledTaskId]);
      if (task[0]?.author_json) return JSON.parse(task[0].author_json as string) as TurnAuthor;
    }
  }
}

/** Resolve a native session to the exact run's input, never the last message or last socket in a space. */
export async function resolveTurnAuthor(sessionId: string, query: Query, seen = new Set<string>(), at?: number): Promise<TurnAuthor | undefined> {
  if (seen.has(sessionId) || seen.size >= 32) return;
  seen.add(sessionId);
  const rows = await query(`SELECT r.run_id FROM orchestration_v2_projection_provider_threads p
    JOIN orchestration_v2_projection_runs r ON r.thread_id=p.thread_id
    WHERE json_extract(p.payload_json,'$.nativeThreadRef.nativeId')=?
      AND json_extract(r.payload_json,'$.providerThreadId')=p.provider_thread_id
      AND ${at === undefined ? "r.status IN ('starting','running','waiting')" : "r.started_at<=?"}
    ORDER BY r.ordinal DESC LIMIT 1`, at === undefined ? [sessionId] : [sessionId, new Date(at).toISOString()]);
  if (rows[0]) return runAuthor(rows[0].run_id, query);
  // Provider-native children have runless T3 threads. Their active call records the parent's exact run, including
  // reuse of an old session. A child joined while still running keeps its first active caller's identity.
  if (at === undefined) {
    const calls = await query(`SELECT s.run_id,s.thread_id FROM orchestration_v2_projection_subagents s
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=s.provider_thread_id
      WHERE json_extract(p.payload_json,'$.nativeThreadRef.nativeId')=? AND s.origin='provider_native'
        AND s.status IN ('pending','running','waiting') ORDER BY s.started_at,s.subagent_id LIMIT 1`, [sessionId]);
    if (calls[0]?.run_id) return runAuthor(calls[0].run_id, query);
    if (calls[0]) {
      const parent = await query(`SELECT json_extract(payload_json,'$.nativeThreadRef.nativeId') AS native_id
        FROM orchestration_v2_projection_provider_threads WHERE thread_id=?`, [calls[0].thread_id]);
      if (parent[0]?.native_id) return resolveTurnAuthor(String(parent[0].native_id), query, seen);
      return;
    }
    const known = await query(`SELECT 1 FROM orchestration_v2_projection_subagents s
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=s.provider_thread_id
      WHERE json_extract(p.payload_json,'$.nativeThreadRef.nativeId')=? AND s.origin='provider_native' LIMIT 1`, [sessionId]);
    if (known.length) return; // A completed/reused child must not borrow its original author's credential.
  }
  // Native children inherit the parent's turn at birth, even if another author starts a later parent turn.
  const native = await query("SELECT parent_id, time_created FROM session_v2 WHERE id=?", [sessionId]);
  if (!native[0]?.parent_id) return;
  return resolveTurnAuthor(String(native[0].parent_id), query, seen, Math.min(at ?? Infinity, Number(native[0].time_created)));
}
