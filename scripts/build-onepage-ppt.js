const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "张冉冉";
pres.title = "huaweicloud-mate 华为云 Agent 插件";

const C = {
  teal: "028090", dark: "1A1A2E", white: "FFFFFF",
  seafoam: "00A896", gray: "64748B", light: "F0FDFA",
  mint: "5EEAD4", slate: "334155", cream: "F8FAFC",
  green: "10B981", amber: "F59E0B", red: "EF4444",
  indigo: "4F46E5",
};
const shadow = { type: "outer", blur: 3, offset: 1, angle: 135, color: "000000", opacity: 0.06 };

// ══════════════════════════════════════════════════════════
// ONE SLIDE — Complete Framework
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  // ─── Header ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.6, fill: { color: C.teal } });
  s.addText("huaweicloud-mate  华为云 Agent 插件 — 完整架构", {
    x: 0.3, y: 0, w: 9.4, h: 0.6, fontSize: 18, fontFace: "Noto Sans CJK SC", color: C.white, valign: "middle", margin: 0,
  });

  // ─── Row 1: Agent + 6 Components ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 0.72, w: 9.4, h: 0.38, fill: { color: C.indigo } });
  s.addText("Agent 层  OpenCode / Claude Code / Codex / 华为云码道", {
    x: 0.3, y: 0.72, w: 9.4, h: 0.38, fontSize: 9, fontFace: "Noto Sans CJK SC", color: C.white, align: "center", valign: "middle", margin: 0,
  });

  s.addText("▼  MCP stdio", { x: 4, y: 1.1, w: 2, h: 0.18, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.gray, align: "center", margin: 0 });

  // ─── Row 2: Router Core ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 1.3, w: 9.4, h: 1.22, fill: { color: C.light }, shadow: shadow });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 1.3, w: 9.4, h: 0.03, fill: { color: C.teal } });
  s.addText("Router 核心调度层", { x: 0.5, y: 1.35, w: 3, h: 0.25, fontSize: 11, fontFace: "Noto Sans CJK SC", color: C.teal, margin: 0 });

  // 5 Tools
  const tools = ["搜索能力","获取详情","健康检查","风险审批","分发执行"];
  tools.forEach((t,i)=>{
    s.addShape(pres.shapes.RECTANGLE, { x: 0.5+i*1.85, y: 1.65, w: 1.7, h: 0.42, fill: { color: C.white } });
    s.addText(["① search","② describe","③ status","④ plan","⑤ execute"][i], {
      x: 0.55+i*1.85, y: 1.66, w: 1.6, h: 0.22, fontSize: 7.5, fontFace: "Noto Sans CJK SC", bold: true, color: C.teal, margin: 0,
    });
    s.addText(t, { x: 0.55+i*1.85, y: 1.86, w: 1.6, h: 0.18, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.gray, margin: 0 });
  });

  // 5 Engine modules
  const engines = [
    { n:"Catalog", d:"15,475能力\n210产品", c:C.teal },
    { n:"Policy", d:"5级风险\nplan token", c:C.seafoam },
    { n:"Credential", d:"~/.hcloud/\ncredentials", c:C.mint },
    { n:"Audit", d:"JSONL\n全链路", c:C.indigo },
    { n:"Installer", d:"KooCLI自动\nSHA256校验", c:C.gray },
  ];
  engines.forEach((e,i)=>{
    s.addShape(pres.shapes.RECTANGLE, { x: 0.5+i*1.85, y: 2.14, w: 1.7, h: 0.32, fill: { color: e.c, transparency: 85 } });
    s.addText(e.n, { x: 0.55+i*1.85, y: 2.15, w: 0.75, h: 0.15, fontSize: 7.5, fontFace: "Noto Sans CJK SC", bold: true, color: e.c, margin: 0 });
    s.addText(e.d, { x: 1.25+i*1.85, y: 2.15, w: 0.9, h: 0.3, fontSize: 5.5, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0 });
  });

  // ─── Row 3: 6 Component Cards ───
  s.addText("▼  六大组件", { x: 4, y: 2.55, w: 2, h: 0.18, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.gray, align: "center", margin: 0 });

  const cards = [
    { icon:"🧠", title:"Skill", sub:"指导型", desc:"Agent操作指南\n安全约束+策略\nMarkdown注入", c:C.green, v:"v1 ✅" },
    { icon:"🔧", title:"MCP", sub:"工具型", desc:"产品原子操作\nAPIE→自动生成\nMetaMCP管理", c:C.teal, v:"v1 ✅" },
    { icon:"💻", title:"KooCLI", sub:"命令型", desc:"CLI快速执行\n210产品全覆盖\n自动安装+锁定", c:C.seafoam, v:"v1 ✅" },
    { icon:"🔍", title:"APIE", sub:"发现型", desc:"接口定义源\nOpenAPI Spec\n驱动Catalog构建", c:C.amber, v:"v1 ✅" },
    { icon:"📦", title:"SDK", sub:"编程型", desc:"进程内调用\n复杂编排+流式\n二期实现", c:C.red, v:"v2 ⏳" },
    { icon:"🏗️", title:"Terraform", sub:"声明型", desc:"资源编排\nplan→apply\n二期实现", c:C.red, v:"v2 ⏳" },
  ];

  cards.forEach((c,i)=>{
    const x = 0.3 + i*1.58;
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.78, w: 1.48, h: 1.2, fill: { color: C.white }, shadow: shadow });
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.78, w: 1.48, h: 0.04, fill: { color: c.c } });
    s.addText(c.icon, { x: x+0.05, y: 2.85, w: 0.3, h: 0.25, fontSize: 14, margin: 0 });
    s.addText(c.title, { x: x+0.38, y: 2.87, w: 0.6, h: 0.2, fontSize: 11, fontFace: "Noto Sans CJK SC", color: c.c, margin: 0 });
    s.addText(c.v, { x: x+1.0, y: 2.88, w: 0.4, h: 0.18, fontSize: 6, fontFace: "Noto Sans CJK SC", color: c.c, margin: 0 });
    s.addText(c.sub, { x: x+0.08, y: 3.1, w: 1.3, h: 0.15, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.gray, italic: true, margin: 0 });
    s.addText(c.desc, { x: x+0.08, y: 3.28, w: 1.3, h: 0.65, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0 });
  });

  // ─── Row 4: Execution paths ───
  s.addText("▼  执行路径", { x: 4, y: 4.02, w: 2, h: 0.18, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.gray, align: "center", margin: 0 });

  // MCP path
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 4.22, w: 4.55, h: 0.5, fill: { color: C.light }, shadow: shadow });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 4.22, w: 0.5, h: 0.5, fill: { color: C.green } });
  s.addText("MCP 路径", { x: 0.9, y: 4.23, w: 2, h: 0.2, fontSize: 9, fontFace: "Noto Sans CJK SC", bold: true, color: C.green, margin: 0 });
  s.addText("Agent→Router→MetaMCP→ecs-mock/obs/nat→华为云API | 语义丰富+产品错误解释+安全分级内置", {
    x: 0.9, y: 4.45, w: 3.8, h: 0.24, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0,
  });

  // KooCLI path
  s.addShape(pres.shapes.RECTANGLE, { x: 5.15, y: 4.22, w: 4.55, h: 0.5, fill: { color: C.light }, shadow: shadow });
  s.addShape(pres.shapes.RECTANGLE, { x: 5.15, y: 4.22, w: 0.5, h: 0.5, fill: { color: C.seafoam } });
  s.addText("KooCLI 回退路径", { x: 5.75, y: 4.23, w: 2, h: 0.2, fontSize: 9, fontFace: "Noto Sans CJK SC", bold: true, color: C.seafoam, margin: 0 });
  s.addText("Agent→Router→spawn(hcloud)→210产品API | 全覆盖+自动安装+SHA256校验+AK/SK脱敏", {
    x: 5.75, y: 4.45, w: 3.8, h: 0.24, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0,
  });

  // ─── Bottom bar: Metrics ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 4.92, w: 10, h: 0.3, fill: { color: C.teal } });
  s.addText("15,475 能力  |  210 产品  |  1,847 行代码  |  KooCLI v7.2.12  |  E2E 5/5  |  OpenCode 已验证  |  已安装即用", {
    x: 0.3, y: 4.92, w: 9.4, h: 0.3, fontSize: 9, fontFace: "Noto Sans CJK SC", color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // ─── Right side: Feature highlights ───
  s.addShape(pres.shapes.RECTANGLE, { x: 7.2, y: 0.72, w: 2.5, h: 0.58, fill: { color: C.light }, shadow: shadow });
  s.addText("核心特点", { x: 7.3, y: 0.74, w: 2, h: 0.2, fontSize: 9, fontFace: "Noto Sans CJK SC", color: C.teal, margin: 0 });
  const features = [
    "固定5工具面 · Agent友好",
    "六大组件 · 统一集成",
    "MCP/KooCLI · 双路回退",
    "一键安装 · KooCLI自举",
    "纵深防御 · AK/SK脱敏",
    "产品部可自主接入",
  ];
  features.forEach((f,i)=>{
    s.addText("▸ "+f, { x: 7.3, y: 0.96+i*0.18, w: 2.3, h: 0.16, fontSize: 6.5, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0 });
  });
}

pres.writeFile({ fileName: "/home/developer/Desktop/huaweicloud-mate/华为云Agent插件-完整架构(一页).pptx" })
  .then(() => console.log("✅ PPT saved"))
  .catch((e) => console.error("❌", e.message));
