import { promises as fs } from "node:fs";
import path from "node:path";

let next = 0;

/** Writes through a temporary file and a rename, so readers never see a partial file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // The temporary name must not end in `.json`: the runner reads every `*.json` in its queues.
  const tmp = `${file}.${process.pid}-${next++}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readJson<T = unknown>(file: string): Promise<T | null> {
  const text = await readText(file);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

/** The last `maxBytes` of a file, starting at a line boundary. */
export async function readTail(file: string, maxBytes: number): Promise<string> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline >= 0 ? text.slice(newline + 1) : text;
  } finally {
    await handle.close();
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** JSON in the 2-space style pi writes, with a trailing newline. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
