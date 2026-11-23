// Deletes the mock store state (data/). Data is regenerated on next use.
import fs from "node:fs";
fs.rmSync(new URL("../data", import.meta.url), { recursive: true, force: true });
console.log("Mock data deleted — it will be regenerated on next use.");
