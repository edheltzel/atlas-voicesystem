import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe("universal core host boundary", () => {
  test("core files do not contain host-specific markers", () => {
    const offenders: string[] = [];
    for (const file of filesUnder("core")) {
      const content = readFileSync(file, "utf8");
      if (/PAI|Claude|\.claude|OpenCode|\bPi\b/.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
