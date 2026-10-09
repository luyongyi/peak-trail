import { parentPort, workerData } from "node:worker_threads";
import { ingestUpload, listGroups, queryRoutes, autoApprovePending, queryInspection } from "./trajectory-store.mjs";

let migrationComplete = false;
try {
  const { operation, root, catalogPath } = workerData;
  if (workerData.migratePending) await autoApprovePending(root);
  migrationComplete = true;
  const result = operation === "upload" ? await ingestUpload(root, Buffer.from(workerData.body), catalogPath)
    : operation === "groups" ? await listGroups(root, catalogPath)
      : operation === "inspection" ? await queryInspection(root, catalogPath, workerData.group, workerData.upload, workerData.stage)
      : await queryRoutes(root, catalogPath, workerData.group, workerData.stage, workerData.difficulty, workerData.limit, operation === "heatmap");
  parentPort.postMessage({ json: JSON.stringify(result), duplicate: result.duplicate, migrationComplete });
} catch (error) { parentPort.postMessage({ error: error.message, statusCode: error.statusCode ?? 500, migrationComplete }); }
