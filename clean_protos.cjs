// Post-codegen step for `npm run build:protos`: protobuf-es emits relative
// imports without file extensions, which Node's ESM resolver rejects. This
// rewrites `from "./x"` -> `from "./x.js"` across the generated protos so the
// output is importable as ESM. Ported from the App Hosting adapter POC.
const fs = require("fs");
const path = require("path");

const TARGET_DIR = "./src/routing-service/protos";

// Captures: (1) the `from '` prefix, (2) the relative path, (3) the closing quote.
const IMPORT_REGEX = /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g;

function walkDirectory(directory, processFile) {
  const items = fs.readdirSync(directory);
  for (const item of items) {
    const fullPath = path.join(directory, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walkDirectory(fullPath, processFile);
    } else if (fullPath.endsWith(".ts")) {
      processFile(fullPath);
    }
  }
}

function addJsExtensions(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  let changesMade = false;
  const newContent = content.replace(IMPORT_REGEX, (match, pre, importPath, post) => {
    if (path.extname(importPath)) return match; // already has an extension
    changesMade = true;
    return `${pre}${importPath}.js${post}`;
  });
  if (changesMade) fs.writeFileSync(filePath, newContent, "utf8");
}

try {
  walkDirectory(TARGET_DIR, addJsExtensions);
} catch (error) {
  console.error(`Error processing files: ${error.message}`);
  process.exit(1);
}
