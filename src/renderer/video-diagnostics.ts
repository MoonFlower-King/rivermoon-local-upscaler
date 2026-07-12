import { redactDiagnosticsText } from "../main/diagnostics-redaction";
import type { VideoGenTask } from "../main/types";

export function videoTaskDiagnosticText(task: VideoGenTask): string {
  const payload = {
    kind: "rivermoon-video-task",
    local_task_id: safeDiagnosticId(task.id),
    status: task.status,
    message: safeVideoDiagnosticField(task.message, task.params.prompt),
    error: safeVideoDiagnosticField(task.error, task.params.prompt),
    needs_topup: task.needsTopup,
    progress: task.progress,
    remote_job_id: task.remoteJobId,
    request_id: task.requestId,
    client_request_id: safeDiagnosticId(task.clientRequestId),
    dry_run: task.dryRun,
    model: task.params.model,
    endpoint: task.params.endpoint,
    aspect_ratio: task.params.aspectRatio,
    duration: task.params.duration,
    resolution: task.params.resolution,
    reference_count: task.params.referencePaths.length,
    reference_types: task.params.referenceTypes,
    prompt_length: task.params.prompt.length,
    cost_usd: task.costUsd,
    estimated_cost_usd: task.estimatedCostUsd,
    charged: task.charged,
    refunded: task.refunded,
    output_file: task.outputPath ? basename(task.outputPath) : null,
    output_bytes: task.outputBytes,
    created_at: new Date(task.createdAt).toISOString(),
    started_at: task.startedAt ? new Date(task.startedAt).toISOString() : null,
    finished_at: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
    duration_ms: task.durationMs
  };
  return JSON.stringify(payload, null, 2);
}

function safeDiagnosticId(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function safeVideoDiagnosticField(value: string | null, prompt: string): string | null {
  if (value == null) return null;
  let result = redactDiagnosticsText(value);
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length >= 8) {
    result = result.split(trimmedPrompt).join("[prompt]");
  }
  return result;
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}
