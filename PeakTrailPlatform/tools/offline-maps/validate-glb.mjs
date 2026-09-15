import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import validator from './gltf-deps/node_modules/gltf-validator/index.js';
const summaryOnly=process.argv.includes('--summary'), totals={files:0,errors:0,warnings:0};
for (const path of process.argv.slice(2).filter(arg=>arg!=='--summary')) {
  const stored = await readFile(path);
  const bytes = stored[0]===0x1f && stored[1]===0x8b ? gunzipSync(stored,{maxOutputLength:128*1024*1024}) : stored;
  const result = await validator.validateBytes(new Uint8Array(bytes), { uri: path, maxIssues: 0, ignoredIssues: ['UNSUPPORTED_EXTENSION', 'UNUSED_OBJECT'] });
  totals.files++;totals.errors+=result.issues.numErrors;totals.warnings+=result.issues.numWarnings;
  if(!summaryOnly || result.issues.numErrors || result.issues.numWarnings)console.log(JSON.stringify({ path, errors: result.issues.numErrors, warnings: result.issues.numWarnings, messages: result.issues.messages }, null, 2));
  if (result.issues.numErrors) process.exitCode = 1;
}
if(summaryOnly)console.log(JSON.stringify(totals));
