const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "张冉冉";
pres.title = "huaweicloud-mate";

const C = {
  teal: "028090", dark: "1A1A2E", white: "FFFFFF",
  seafoam: "00A896", gray: "64748B", light: "F0FDFA",
  mint: "5EEAD4", slate: "334155", green: "10B981",
  indigo: "4F46E5", amber: "F59E0B",
};
const F = { title: "Noto Sans CJK SC", body: "Noto Sans CJK SC" };
const sh = { type: "outer", blur: 3, offset: 1, angle: 135, color: "000000", opacity: 0.06 };

// ═══════════════════════════════════════════════
// ONE PAGE
// ═══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  // Header bar
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.52, fill: { color: C.teal } });
  s.addText("huaweicloud-mate  华为云 Agent 插件 — Skill · MCP · KooCLI · APIE · SDK · Terraform", {
    x: 0.3, y: 0, w: 9.4, h: 0.52, fontSize: 16, fontFace: F.title, color: C.white, valign: "middle", margin: 0,
  });

  // ── Layer 1: Agent ──
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 0.65, w: 9.4, h: 0.32, fill: { color: C.indigo } });
  s.addText("Agent 层  OpenCode / Claude Code / Codex / 华为云码道", {
    x: 0.3, y: 0.65, w: 9.4, h: 0.32, fontSize: 9, fontFace: F.body, color: C.white, align: "center", valign: "middle", margin: 0,
  });
  s.addText("▼  MCP stdio JSON-RPC", { x: 4, y: 0.98, w: 2, h: 0.16, fontSize: 7, fontFace: F.body, color: C.gray, align: "center", margin: 0 });

  // ── Layer 2: Router Core ──
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 1.15, w: 9.4, h: 1.08, fill: { color: C.light }, shadow: sh });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 1.15, w: 9.4, h: 0.035, fill: { color: C.teal } });
  s.addText("Router 核心调度层", { x: 0.5, y: 1.2, w: 3, h: 0.22, fontSize: 10, fontFace: F.title, color: C.teal, margin: 0 });

  // 5 Tools
  const tools = [
    { n:"① search", d:"搜索能力" }, { n:"② describe", d:"获取详情" },
    { n:"③ status", d:"健康检查" }, { n:"④ plan", d:"风险审批" }, { n:"⑤ execute", d:"分发执行" },
  ];
  tools.forEach((t,i)=>{
    s.addShape(pres.shapes.RECTANGLE, { x:0.5+i*1.85, y:1.48, w:1.7, h:0.35, fill:{ color:C.white } });
    s.addText(t.n, { x:0.55+i*1.85, y:1.49, w:1.6, h:0.18, fontSize:7.5, fontFace:F.title, color:C.teal, margin:0 });
    s.addText(t.d, { x:0.55+i*1.85, y:1.66, w:1.6, h:0.15, fontSize:7, fontFace:F.body, color:C.gray, margin:0 });
  });

  // 5 Engines
  const engs = [
    { n:"Catalog", d:"15,475能力/210产品", c:C.teal },
    { n:"Policy", d:"5级风险+plan token", c:C.seafoam },
    { n:"Credential", d:"~/.hcloud/credentials", c:C.mint },
    { n:"Audit", d:"JSONL 全链路审计", c:C.indigo },
    { n:"Installer", d:"KooCLI自动+SHA256", c:C.gray },
  ];
  engs.forEach((e,i)=>{
    s.addShape(pres.shapes.RECTANGLE, { x:0.5+i*1.85, y:1.88, w:1.7, h:0.28, fill:{ color:e.c, transparency:85 } });
    s.addText(e.n, { x:0.55+i*1.85, y:1.89, w:0.75, h:0.14, fontSize:7.5, fontFace:F.title, color:e.c, margin:0 });
    s.addText(e.d, { x:1.25+i*1.85, y:1.89, w:0.9, h:0.26, fontSize:5.5, fontFace:F.body, color:C.slate, margin:0 });
  });

  // ── Layer 3: 6 Component Cards ──
  s.addText("▼  六大组件协同", { x: 4, y: 2.26, w: 2, h: 0.16, fontSize: 7, fontFace: F.body, color: C.gray, align: "center", margin: 0 });

  const cards = [
    { icon:"🧠", n:"Skill", t:"指导路径", d:"Agent 上下文\n操作指南+安全约束\n执行器选择策略", c:C.green, flow:"skills/*.md → Agent" },
    { icon:"🔧", n:"MCP", t:"工具路径", d:"产品原子操作\nAPIE→自动生成\nMetaMCP 统一管理", c:C.teal, flow:"Router→ecs/obs/nat→API" },
    { icon:"💻", n:"KooCLI", t:"命令路径", d:"CLI 快速执行\n210 产品全覆盖\n自动安装+SHA256", c:C.seafoam, flow:"Router→spawn hcloud→API" },
    { icon:"🔍", n:"APIE", t:"发现路径", d:"接口定义单一真相源\nOpenAPI Spec\n驱动 Catalog 构建", c:C.amber, flow:"APIE→Spec→Catalog" },
    { icon:"📦", n:"SDK", t:"编程路径", d:"进程内 import 调用\n复杂编排+流式分页\n免子进程延迟", c:C.indigo, flow:"Router→SDK Client→API" },
    { icon:"🏗️", n:"TF", t:"声明路径", d:"基础设施即代码\n多资源编排+幂等\nplan→审查→apply", c:C.gray, flow:"Router→plan→审查→apply" },
  ];

  cards.forEach((c,i)=>{
    const x = 0.3 + i*1.58;
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.45, w: 1.48, h: 1.15, fill: { color: C.white }, shadow: sh });
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.45, w: 1.48, h: 0.04, fill: { color: c.c } });
    s.addText(c.icon, { x: x+0.05, y: 2.5, w: 0.28, h: 0.22, fontSize: 12, margin: 0 });
    s.addText(c.n, { x: x+0.35, y: 2.5, w: 0.6, h: 0.2, fontSize: 10, fontFace: F.title, color: c.c, margin: 0 });
    s.addText(c.t, { x: x+0.05, y: 2.72, w: 1.38, h: 0.14, fontSize: 6.5, fontFace: F.body, color: C.gray, italic: true, margin: 0 });
    s.addText(c.d, { x: x+0.05, y: 2.88, w: 1.38, h: 0.5, fontSize: 6.5, fontFace: F.body, color: C.slate, margin: 0 });
    s.addText(c.flow, { x: x+0.05, y: 3.42, w: 1.38, h: 0.16, fontSize: 5.5, fontFace: F.body, color: c.c, margin: 0 });
  });

  // ── Layer 4: Huawei Cloud ──
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 3.7, w: 9.4, h: 0.32, fill: { color: C.dark } });
  s.addText("☁️  华为云 — ECS · OBS · VPC · IAM · RDS · ELB · NAT · CCE · DNS · CES · ... 210 产品", {
    x: 0.3, y: 3.7, w: 9.4, h: 0.32, fontSize: 9, fontFace: F.body, color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // ── Feature highlights (right side over Router layer) ──
  const features = [
    "▸ 固定5工具面 · Agent友好",
    "▸ 六大组件 · 统一集成",
    "▸ 双路回退 · MCP→KooCLI",
    "▸ 15,475能力 · 全量覆盖",
    "▸ 一键安装 · KooCLI自举",
    "▸ 纵深防御 · AK/SK脱敏",
    "▸ 产品部可自主接入",
    "▸ 4类Agent适配",
  ];
  features.forEach((f,i)=>{
    s.addText(f, { x: 7.5, y: 1.2 + i*0.16, w: 2.1, h: 0.15, fontSize: 6.5, fontFace: F.body, color: C.slate, margin: 0 });
  });

  // ── Bottom metrics bar ──
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 4.22, w: 10, h: 0.28, fill: { color: C.teal } });
  s.addText("15,475 能力 | 210 产品 | 1,847 行代码 | KooCLI v7.2.12 | E2E 5/5 | OpenCode 已验证", {
    x: 0.3, y: 4.22, w: 9.4, h: 0.28, fontSize: 8.5, fontFace: F.body, color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // Feature title
  s.addText("核心特点", { x: 7.5, y: 1.02, w: 2, h: 0.16, fontSize: 8, fontFace: F.title, color: C.teal, margin: 0 });
}

pres.writeFile({ fileName: "/home/developer/Desktop/huaweicloud-mate/华为云Agent插件-完整架构.pptx" })
  .then(() => console.log("✅ PPT saved"))
  .catch((e) => console.error("❌", e.message));
