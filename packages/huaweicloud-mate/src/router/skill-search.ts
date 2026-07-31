// huaweicloud-mate/src/router/skill-search.ts
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const SKILLS_ROOT = process.env.SKILLS_ROOT || "/skills";

interface SkillEntry {
  name: string;
  description: string;
  path: string;
}

function loadSkillIndex(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (!existsSync(SKILLS_ROOT)) return entries;

  function walk(dir: string) {
    const items = readdirSync(dir);
    for (const item of items) {
      const full = join(dir, item);
      if (!statSync(full).isDirectory()) continue;

      const skillFile = join(full, "SKILL.md");
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, "utf-8");
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        const descMatch = content.match(/^description:\s*\|\s*\n((?:\s{2}.+\n?)*)/m);
        const name = nameMatch ? nameMatch[1].trim() : item;
        const desc = descMatch ? descMatch[1].trim().replace(/\n\s{2}/g, " ") : "";
        entries.push({ name, description: desc, path: skillFile });
      } else {
        walk(full);
      }
    }
  }
  walk(SKILLS_ROOT);
  return entries;
}

export function searchSkills(query: string): { match: SkillEntry | null; fullContent: string } {
  const index = loadSkillIndex();
  const q = query.toLowerCase();

  let best: SkillEntry | null = null;
  let bestScore = 0;

  for (const entry of index) {
    const text = `${entry.name} ${entry.description}`.toLowerCase();
    const words = q.split(/\s+/);
    const score = words.filter(w => text.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  let fullContent = "";
  if (best && existsSync(best.path)) {
    fullContent = readFileSync(best.path, "utf-8");
  }

  return { match: best, fullContent };
}
