const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "huaweicloud-mate";

const C = {
  teal: "028090", dark: "1A1A2E", white: "FFFFFF",
  mint: "5EEAD4", gray: "64748B", light: "F0FDFA", slate: "334155",
  green: "10B981", amber: "F59E0B", indigo: "4F46E5",
};
const F = { t: "Noto Sans CJK SC", b: "Noto Sans CJK SC" };

{
  const s = pres.addSlide();
  s.background = { color: C.white };

  // ═══ Top bar: Title + Intro + Goals in one row ═══
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.68, fill: { color: C.teal } });
  s.addText("huaweicloud-mate  华为云 Agent 插件", {
    x: 0.4, y: 0.02, w: 5.5, h: 0.36, fontSize: 16, fontFace: F.t, color: C.white, valign: "middle", margin: 0,
  });
  s.addText("Skill · MCP · KooCLI · API Explorer · SDK · Terraform", {
    x: 0.4, y: 0.38, w: 5.5, h: 0.22, fontSize: 7.5, fontFace: F.b, color: C.mint, valign: "middle", margin: 0,
  });

  // 3 Goals compact
  const goals = [
    { t: "让 Agent 操作华为云", d: "5工具·15K能力·210产品" },
    { t: "降低产品部接入成本", d: "APIE→MCP自动生成" },
    { t: "统一多 Agent 体验", d: "4类Agent一套适配" },
  ];
  goals.forEach((g,i)=>{
    const x = 6.0 + i*1.35;
    s.addShape(pres.shapes.RECTANGLE, { x, y:0.06, w:1.28, h:0.56, fill:{ color:C.white, transparency:85 } });
    s.addText(g.t, { x:x+0.06, y:0.08, w:1.16, h:0.28, fontSize:7, fontFace:F.t, color:C.white, margin:0, align:"center",valign:"bottom" });
    s.addText(g.d, { x:x+0.06, y:0.35, w:1.16, h:0.22, fontSize:6, fontFace:F.b, color:C.mint, margin:0, align:"center",valign:"top" });
  });

  // ═══ Agent layer ═══
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 0.76, w: 9.4, h: 0.28, fill: { color: C.indigo } });
  s.addText("Agent 层    OpenCode  ·  Claude Code  ·  Codex  ·  华为云码道", {
    x: 0.3, y: 0.76, w: 9.4, h: 0.28, fontSize: 8.5, fontFace: F.b, color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // ═══ Router ═══
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 1.1, w: 9.4, h: 0.64, fill: { color: C.light } });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 1.1, w: 9.4, h: 0.03, fill: { color: C.teal } });
  s.addText("Router 核心 — 5 工具: search · describe · status · plan · execute", {
    x: 0.5, y: 1.12, w: 8.5, h: 0.2, fontSize: 9, fontFace: F.t, color: C.teal, margin: 0,
  });
  // Engines (one line)
  [
    "能力目录 15,475/210", "策略引擎 5级风险+token", "凭证 ~/.hcloud/ini",
    "审计 JSONL全链路", "KooCLI安装 自动+SHA256",
  ].forEach((e,i)=>{
    s.addText(e, { x:0.5+i*1.82, y:1.4, w:1.72, h:0.24, fontSize:7, fontFace:F.b, color:C.slate, margin:0, valign:"middle" });
  });

  // ═══ 6 Components ═══
  s.addText("六大组件", { x: 4.3, y: 1.82, w: 1.4, h: 0.16, fontSize: 7.5, fontFace: F.t, color: C.gray, align: "center", margin: 0 });

  const cards = [
    { icon:"🧠", n:"Skill", t:"指导", d:"Agent操作指南\n安全策略注入", c:C.green, f:"skills/*.md → Agent" },
    { icon:"🔧", n:"MCP", t:"工具", d:"产品原子操作\nAPIE自动生成", c:C.teal, f:"Router→ecs/obs/nat" },
    { icon:"💻", n:"KooCLI", t:"命令", d:"CLI快速执行\n210产品全覆盖", c:C.seafoam, f:"Router→spawn hcloud" },
    { icon:"🔍", n:"APIE", t:"发现", d:"接口定义源\n驱动Catalog构建", c:C.amber, f:"APIE→Spec→Catalog" },
    { icon:"📦", n:"SDK", t:"编程", d:"进程内import\n复杂编排+流式", c:C.indigo, f:"Router→SDK Client" },
    { icon:"🏗️", n:"TF", t:"声明", d:"基础设施即代码\nplan→审查→apply", c:C.gray, f:"Router→plan→apply" },
  ];

  cards.forEach((c,i)=>{
    const x = 0.3 + i*1.58;
    const cardY = 2.0, cardH = 1.15;

    s.addShape(pres.shapes.RECTANGLE, { x, y: cardY, w: 1.48, h: cardH, fill: { color: C.white } });
    s.addShape(pres.shapes.RECTANGLE, { x, y: cardY, w: 1.48, h: 0.04, fill: { color: c.c } });

    // Icon + Name + Type tag
    s.addText(c.icon, { x: x+0.06, y: cardY+0.06, w: 0.28, h: 0.22, fontSize: 12, margin: 0 });
    s.addText(c.n, { x: x+0.36, y: cardY+0.06, w: 0.65, h: 0.14, fontSize: 10, fontFace: F.t, color: c.c, margin: 0 });
    s.addText(c.t, { x: x+1.0, y: cardY+0.07, w: 0.4, h: 0.14, fontSize: 6.5, fontFace: F.b, color: C.gray, margin: 0 });

    // Description
    s.addText(c.d, { x: x+0.06, y: cardY+0.32, w: 1.36, h: 0.45, fontSize: 7.5, fontFace: F.b, color: C.slate, margin: 0 });

    // Flow
    s.addText(c.f, { x: x+0.06, y: cardY+0.8, w: 1.36, h: 0.25, fontSize: 7, fontFace: F.b, color: c.c, margin: 0, italic: true });
  });

  // ═══ Cloud ═══
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 3.25, w: 9.4, h: 0.26, fill: { color: C.dark } });
  s.addText("华为云    ECS · OBS · VPC · IAM · RDS · ELB · NAT · CCE · DNS · CES  等 210 产品", {
    x: 0.3, y: 3.25, w: 9.4, h: 0.26, fontSize: 8.5, fontFace: F.b, color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // ═══ Features ═══
  s.addShape(pres.shapes.RECTANGLE, { x: 0.3, y: 3.6, w: 9.4, h: 0.42, fill: { color: C.light } });
  const feats = [
    "固定5工具面 · Agent友好",
    "六大组件 · 统一集成",
    "双路回退 · 自动降级",
    "15,475能力 · 全量覆盖",
    "一键安装 · KooCLI自举",
    "纵深防御 · AK/SK脱敏",
    "产品部可自主接入",
    "4类Agent · 一套适配",
  ];
  feats.forEach((f,i)=>{
    const col = i%4, row = Math.floor(i/4);
    const x = 0.45+col*2.3, y = 3.62+row*0.2;
    s.addText("● " + f, { x, y, w: 2.2, h: 0.18, fontSize: 7.5, fontFace: F.b, color: C.slate, margin: 0, valign: "middle" });
  });

  // ═══ Metrics ═══
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 4.14, w: 10, h: 0.25, fill: { color: C.teal } });
  s.addText("15,475 能力  |  210 产品  |  KooCLI v7.2.12  |  E2E 5/5 通过  |  OpenCode 已验证", {
    x: 0.3, y: 4.14, w: 9.4, h: 0.25, fontSize: 9, fontFace: F.b, color: C.white, align: "center", valign: "middle", margin: 0,
  });
}

pres.writeFile({ fileName: "/home/developer/Desktop/huaweicloud-mate/华为云Agent插件-完整架构.pptx" })
  .then(() => console.log("✅ PPT saved — 1 page, clean"))
  .catch(e => console.error("❌", e.message));
