import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const clientDirectory = join(process.cwd(), "dist", "client");
const shellPath = join(clientDirectory, "_shell.html");
let shell = await readFile(shellPath, "utf8");
let externalScriptCount = 0;
const writes = [];

shell = shell.replace(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g, (_tag, attributes, source) => {
  // HTML parsers replace null bytes before evaluating inline script. Preserve that behavior now
  // that the generated TanStack bootstrap is served as an external asset.
  const normalizedSource = source.replaceAll("\0", "\uFFFD");
  const digest = createHash("sha256").update(normalizedSource).digest("hex").slice(0, 16);
  const filename = `spa-bootstrap-${digest}.js`;
  writes.push(writeFile(join(clientDirectory, "assets", filename), normalizedSource));
  externalScriptCount += 1;
  return `<script${attributes} src="/assets/${filename}"></script>`;
});

if (externalScriptCount === 0) {
  throw new Error("TanStack SPA shell contained no bootstrap scripts to externalize.");
}
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(shell) || /<style\b/i.test(shell)) {
  throw new Error("SPA shell still contains inline script or style elements.");
}

await Promise.all(writes);
await writeFile(shellPath, shell);
