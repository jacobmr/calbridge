import { runSyncFlow, runAllSyncs } from "../../lib/sync-engine.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return;
  }

  const auth = req.headers?.authorization || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!auth || auth !== expected) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const flowId = url.searchParams.get("flow_id");

    let result;
    if (flowId) {
      const run = await runSyncFlow(flowId);
      result = {
        ok: true,
        runs: [run],
        totals: {
          created: run.created,
          skipped: run.skipped,
          errors: run.errors,
        },
      };
    } else {
      const summary = await runAllSyncs();
      result = { ok: true, ...summary };
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    const status = e.statusCode || 500;
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
