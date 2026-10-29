import { WorkspaceError } from "../workspace/errors.mjs";

export const SOURCE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
export const PART_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

// The deadline lasts until the source body finishes or is cancelled. Errors
// propagate through R2.put(), so staging cleanup runs before publication.
export function uploadStream(input, timeoutMs = SOURCE_UPLOAD_TIMEOUT_MS) {
  const reader = input.getReader(); let done = false, timer;
  const finish = () => { if (done) return false; done = true; clearTimeout(timer); return true; };
  return new ReadableStream({
    start(output) {
      timer = setTimeout(() => {
        if (!finish()) return;
        const error = new WorkspaceError("UPLOAD_TIMEOUT", "上传超时，请重试或改用分块上传。", 408);
        output.error(error); reader.cancel(error).catch(() => {});
      }, timeoutMs);
    },
    async pull(output) {
      try {
        const value = await reader.read();
        if (done) return;
        if (value.done) { finish(); reader.releaseLock(); output.close(); }
        else output.enqueue(value.value);
      } catch (error) { if (finish()) output.error(error); await reader.cancel(error).catch(() => {}); }
    },
    async cancel(reason) { finish(); await reader.cancel(reason).catch(() => {}); },
  }, { highWaterMark: 0 });
}
