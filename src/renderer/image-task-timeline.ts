function hasSubmissionOrder(orders: Readonly<Record<string, number>>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(orders, id);
}

export function appendImageTaskIdInSubmissionOrder(
  taskIds: readonly string[],
  taskId: string,
  submissionOrders: Readonly<Record<string, number>>
): string[] {
  const uniqueIds = Array.from(new Set([...taskIds, taskId]));
  const persistedIds = uniqueIds.filter((id) => !hasSubmissionOrder(submissionOrders, id));
  const submittedIds = uniqueIds
    .filter((id) => hasSubmissionOrder(submissionOrders, id))
    .sort((left, right) => submissionOrders[left]! - submissionOrders[right]!);
  return [...persistedIds, ...submittedIds];
}

export type ImageTaskTimelineEntry<TTask, TPending> =
  { kind: "task"; id: string; task: TTask } | { kind: "pending"; id: string; submission: TPending };

export function mergeImageTaskTimeline<TTask extends { id: string }, TPending extends { id: string; order: number }>(
  tasks: readonly TTask[],
  pendingSubmissions: readonly TPending[],
  submissionOrders: Readonly<Record<string, number>>
): Array<ImageTaskTimelineEntry<TTask, TPending>> {
  return [
    ...tasks.map((task, index) => {
      const submissionOrder = submissionOrders[task.id];
      return {
        kind: "task" as const,
        id: task.id,
        tier: submissionOrder == null ? 0 : 1,
        order: submissionOrder ?? tasks.length - index,
        task
      };
    }),
    ...pendingSubmissions.map((submission) => ({
      kind: "pending" as const,
      id: submission.id,
      tier: 1,
      order: submission.order,
      submission
    }))
  ]
    .sort((left, right) => right.tier - left.tier || right.order - left.order)
    .map((entry) =>
      entry.kind === "pending"
        ? { kind: entry.kind, id: entry.id, submission: entry.submission }
        : { kind: entry.kind, id: entry.id, task: entry.task }
    );
}
