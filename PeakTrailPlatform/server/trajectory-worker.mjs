import { parentPort, workerData } from "node:worker_threads";
import { ingestUpload, listGroups, queryRoutes } from "./trajectory-store.mjs";

try {
  const { operation, root, catalogPath } = workerData;
  const result = operation === "upload" ? await ingestUpload(root, Buffer.from(workerData.body), catalogPath)
    : operation === "groups" ? await listGroups(root, catalogPath)
      : await queryRoutes(root, catalogPath, workerData.group, workerData.stage, workerData.difficulty, workerData.limit, operation === "heatmap");
  parentPort.postMessage({ json: JSON.stringify(result), duplicate: result.duplicate });
} catch (error) { parentPort.postMessage({ error: error.message, statusCode: error.statusCode ?? 500 }); }
