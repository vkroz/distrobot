/** Start the in-process publish worker when the Node.js server boots (so scheduled jobs run without a page visit). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureWorker } = await import("./lib/jobs/worker");
    ensureWorker();
  }
}
