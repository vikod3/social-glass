import { readFile, writeFile } from "node:fs/promises";

const [html, css, javascript] = await Promise.all([
  readFile("index.html", "utf8"),
  readFile("styles.css", "utf8"),
  readFile("liquid-glass-controls.js", "utf8"),
]);

const safeJavascript = javascript.replaceAll("</script", "<\\/script");
const offline = html
  .replace(
    /\s*<link rel="stylesheet" href="styles\.css[^"]*">/,
    () => `\n  <style>\n${css}\n  </style>`,
  )
  .replace(
    /\s*<script src="liquid-glass-controls\.js[^"]*"><\/script>/,
    () => `\n  <script>\n${safeJavascript}\n  </script>`,
  );

await writeFile("screen-3-offline.html", offline, "utf8");
console.log("Built screen-3-offline.html (no server required).");
