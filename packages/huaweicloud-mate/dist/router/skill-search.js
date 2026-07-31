"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchSkills = searchSkills;
// huaweicloud-mate/src/router/skill-search.ts
const fs_1 = require("fs");
const path_1 = require("path");
const SKILLS_ROOT = process.env.SKILLS_ROOT || "/skills";
function loadSkillIndex() {
    const entries = [];
    if (!(0, fs_1.existsSync)(SKILLS_ROOT))
        return entries;
    function walk(dir) {
        const items = (0, fs_1.readdirSync)(dir);
        for (const item of items) {
            const full = (0, path_1.join)(dir, item);
            if (!(0, fs_1.statSync)(full).isDirectory())
                continue;
            const skillFile = (0, path_1.join)(full, "SKILL.md");
            if ((0, fs_1.existsSync)(skillFile)) {
                const content = (0, fs_1.readFileSync)(skillFile, "utf-8");
                const nameMatch = content.match(/^name:\s*(.+)$/m);
                const descMatch = content.match(/^description:\s*\|\s*\n((?:\s{2}.+\n?)*)/m);
                const name = nameMatch ? nameMatch[1].trim() : item;
                const desc = descMatch ? descMatch[1].trim().replace(/\n\s{2}/g, " ") : "";
                entries.push({ name, description: desc, path: skillFile });
            }
            else {
                walk(full);
            }
        }
    }
    walk(SKILLS_ROOT);
    return entries;
}
function searchSkills(query) {
    const index = loadSkillIndex();
    const q = query.toLowerCase();
    let best = null;
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
    if (best && (0, fs_1.existsSync)(best.path)) {
        fullContent = (0, fs_1.readFileSync)(best.path, "utf-8");
    }
    return { match: best, fullContent };
}
