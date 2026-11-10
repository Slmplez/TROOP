import { readFile } from "node:fs/promises";

export async function readDebugPort(file, read = readFile) {
  let content;
  try {
    content = await read(file, "utf8");
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "ENOENT") return null;
    throw error;
  }
  const [line] = content.trim().split(/\r?\n/);
  const port = Number(line);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
