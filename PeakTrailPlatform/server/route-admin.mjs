import { resolve } from "node:path";
import { loadIndex, moderate } from "./trajectory-store.mjs";
import { validHash } from "./trajectory-contract.mjs";

const args = process.argv.slice(2), dirIndex = args.indexOf("--dir");
if (dirIndex < 0 || !args[dirIndex + 1]) throw new Error("Usage: node route-admin.mjs --dir PRIVATE_DIR list|approve|hide|reject|pending [UPLOAD_SHA256]");
const root = resolve(args[dirIndex + 1]); args.splice(dirIndex, 2);
const [command, id] = args;
if (command === "list") console.log(JSON.stringify((await loadIndex(root)).map(({ id, receivedUtc, moderationStatus, map, playerCount, pointCount, routes }) =>
  ({ uploadId: id, receivedUtc, moderationStatus, map, playerCount, pointCount, completeRoutes: routes.length })), null, 2));
else if (["approve", "hide", "reject", "pending"].includes(command) && validHash(id)) console.log(JSON.stringify(await moderate(root, id,
  { approve: "approved", hide: "hidden", reject: "rejected", pending: "pending" }[command])));
else throw new Error("Unknown command or invalid upload SHA256");
