import { describe, expect, it } from "vitest";
import { appendImageTaskIdInSubmissionOrder, mergeImageTaskTimeline } from "../src/renderer/image-task-timeline";

describe("image task submission ordering", () => {
  it("keeps taskIds in click order when IPC responses finish out of order", () => {
    const orders = { first: 1, second: 2 };
    const afterSecond = appendImageTaskIdInSubmissionOrder(["persisted"], "second", orders);
    expect(afterSecond).toEqual(["persisted", "second"]);
    expect(appendImageTaskIdInSubmissionOrder(afterSecond, "first", orders)).toEqual(["persisted", "first", "second"]);
  });

  it("renders a newer resolved task above an older pending submission", () => {
    const timeline = mergeImageTaskTimeline([{ id: "second" }], [{ id: "pending-first", order: 1 }], { second: 2 });
    expect(timeline.map((entry) => entry.id)).toEqual(["second", "pending-first"]);
  });

  it("preserves persisted taskIds order after restart when runtime orders are absent", () => {
    const timeline = mergeImageTaskTimeline([{ id: "newest" }, { id: "middle" }, { id: "oldest" }], [], {});
    expect(timeline.map((entry) => entry.id)).toEqual(["newest", "middle", "oldest"]);
  });
});
