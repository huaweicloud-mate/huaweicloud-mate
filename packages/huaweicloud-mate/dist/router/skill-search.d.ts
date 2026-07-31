interface SkillEntry {
    name: string;
    description: string;
    path: string;
}
export declare function searchSkills(query: string): {
    match: SkillEntry | null;
    fullContent: string;
};
export {};
