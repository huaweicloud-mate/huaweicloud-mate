const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "张冉冉";
pres.title = "华为云 Agent 插件 huaweicloud-mate";

// ─── Color Palette (Teal Trust) ───
const C = {
  teal: "028090",     dark: "1A1A2E",    white: "FFFFFF",
  seafoam: "00A896",  gray: "64748B",    light: "F0FDFA",
  mint: "02C39A",     slate: "334155",   cream: "F8FAFC",
};

// ─── Helper ───
const makeShadow = () => ({ type: "outer", blur: 4, offset: 2, angle: 135, color: "000000", opacity: 0.08 });

// ══════════════════════════════════════════════════════════
// SLIDE 1 — Title
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.teal };

  // Decorative circles
  s.addShape(pres.shapes.OVAL, { x: 7.5, y: -1.5, w: 5, h: 5, fill: { color: C.seafoam, transparency: 60 } });
  s.addShape(pres.shapes.OVAL, { x: 8.5, y: 2.5, w: 3, h: 3, fill: { color: C.mint, transparency: 70 } });

  s.addText("huaweicloud-mate", {
    x: 0.8, y: 1.2, w: 8, h: 1.2, fontSize: 44, fontFace: "Arial Black",
    color: C.white, bold: true, margin: 0,
  });

  s.addText("华为云 Agent 插件", {
    x: 0.8, y: 2.4, w: 8, h: 0.7, fontSize: 24, fontFace: "Arial",
    color: C.mint, margin: 0,
  });

  s.addText("Skill + MCP + KooCLI + SDK + APIE + Terraform 六组件统一集成", {
    x: 0.8, y: 3.2, w: 8, h: 0.5, fontSize: 14, fontFace: "Arial",
    color: C.cream, margin: 0,
  });

  // Status bar
  s.addShape(pres.shapes.RECTANGLE, { x: 0.8, y: 4.2, w: 4.5, h: 0.06, fill: { color: C.mint } });
  s.addText("一期 v1.2  |  10/12 项完成  |  OpenCode 已验证", {
    x: 0.8, y: 4.4, w: 8, h: 0.4, fontSize: 11, fontFace: "Arial",
    color: C.seafoam, margin: 0,
  });
}

// ══════════════════════════════════════════════════════════
// SLIDE 2 — Architecture (6 components)
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  // Header
  s.addText("插件架构", { x: 0.6, y: 0.3, w: 8, h: 0.7, fontSize: 28, fontFace: "Arial Black", color: C.dark, margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 0.95, w: 0.8, h: 0.05, fill: { color: C.teal } });

  // 6 Component Cards — 2 rows x 3 cols
  const cards = [
    { title: "Skill", sub: "指导型组件", desc: "告诉 Agent 何时用哪个执行器\n安全约束 + 错误处理策略\nMarkdown 注入 Agent context", color: C.teal },
    { title: "MCP", sub: "工具型组件", desc: "产品原子操作工具\nAPIE OpenAPI → 自动生成\nexecutor 注册 + 健康检查", color: C.seafoam },
    { title: "KooCLI", sub: "命令型组件", desc: "CLI 快速执行\n200+ 服务全覆盖回退\n自动安装 + SHA256 校验", color: C.mint },
    { title: "API Explorer", sub: "发现型组件", desc: "接口定义单一真相源\n驱动 MCP 自动生成\nCapability Catalog 数据源", color: "0D9488" },
    { title: "SDK", sub: "编程型组件", desc: "进程内程序化调用\n复杂编排 + 流式处理\n二期实现", color: "5EEAD4" },
    { title: "Terraform", sub: "声明型组件", desc: "基础设施即代码\n多资源编排 + 幂等\n二期实现", color: "99F6E4" },
  ];

  cards.forEach((c, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.6 + col * 3.1;
    const y = 1.3 + row * 2.0;
    const w = 2.8;
    const h = 1.7;

    s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: C.light }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: x, y: y, w: w, h: 0.06, fill: { color: c.color } });

    s.addText(c.title, { x: x + 0.15, y: y + 0.2, w: w - 0.3, h: 0.35, fontSize: 16, fontFace: "Arial Black", color: c.color, margin: 0 });
    s.addText(c.sub, { x: x + 0.15, y: y + 0.55, w: w - 0.3, h: 0.25, fontSize: 9, fontFace: "Arial", color: C.gray, italic: true, margin: 0 });
    s.addText(c.desc, { x: x + 0.15, y: y + 0.85, w: w - 0.3, h: 0.75, fontSize: 9, fontFace: "Arial", color: C.slate, margin: 0 });
  });

  // Status footer
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.2, w: 10, h: 0.425, fill: { color: C.teal } });
  s.addText("一期已实现: MCP ✅  KooCLI ✅  APIE ✅  Skill ✅  |  SDK / Terraform 二期", {
    x: 0.6, y: 5.2, w: 8.8, h: 0.425, fontSize: 10, fontFace: "Arial", color: C.white, margin: 0, valign: "middle",
  });
}

// ══════════════════════════════════════════════════════════
// SLIDE 3 — Goals & Status
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  s.addText("插件目标与进展", { x: 0.6, y: 0.3, w: 8, h: 0.7, fontSize: 28, fontFace: "Arial Black", color: C.dark, margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 0.95, w: 0.8, h: 0.05, fill: { color: C.teal } });

  // Left column — 3 Goals
  const goals = [
    { n: "01", title: "Agent 友好", desc: "固定 5 工具面\n语义搜索 15,475 能力\nMCP/KooCLI 双路径自动回退" },
    { n: "02", title: "一键安装", desc: "npm install huaweicloud-mate\n自动检测 Agent 类型\nKooCLI 启动时自动下载安装" },
    { n: "03", title: "产品部可接入", desc: "APIE OpenAPI → MCP 自动生成\n各产品部独立开发 MCP Server\n统一 Catalog 注册发现" },
  ];

  goals.forEach((g, i) => {
    const y = 1.3 + i * 1.3;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y, w: 4.2, h: 1.05, fill: { color: C.light }, shadow: makeShadow() });
    s.addText(g.n, { x: 0.8, y: y + 0.1, w: 0.5, h: 0.4, fontSize: 22, fontFace: "Arial Black", color: C.teal, margin: 0 });
    s.addText(g.title, { x: 1.5, y: y + 0.1, w: 3, h: 0.35, fontSize: 14, fontFace: "Arial", bold: true, color: C.dark, margin: 0 });
    s.addText(g.desc, { x: 1.5, y: y + 0.45, w: 3.1, h: 0.55, fontSize: 9, fontFace: "Arial", color: C.slate, margin: 0 });
  });

  // Right column — Status table
  s.addShape(pres.shapes.RECTANGLE, { x: 5.1, y: 1.3, w: 4.5, h: 3.4, fill: { color: C.light }, shadow: makeShadow() });
  s.addText("一期实现进度", { x: 5.3, y: 1.4, w: 4, h: 0.35, fontSize: 13, fontFace: "Arial Black", color: C.teal, margin: 0 });

  const statusRows = [
    ["Router 5 工具", "✅"], ["KooCLI 自动安装", "✅"], ["Catalog 15,475 能力", "✅"],
    ["MCP + KooCLI 双执行器", "✅"], ["MCP 健康检查", "✅"], ["~/.hcloud/credentials", "✅"],
    ["JSONL 审计日志", "✅"], ["Mock MCP Server", "✅"], ["OpenCode E2E 验证", "✅"],
    ["MetaMCP 集成", "⏳"], ["SDK 路径", "❌ 二期"],
  ];

  s.addTable(
    statusRows.map((r, i) => [
      { text: r[0], options: { fontSize: 9, color: C.slate, fill: { color: i % 2 === 0 ? C.white : C.light }, align: "left" } },
      { text: r[1], options: { fontSize: 10, color: r[1] === "✅" ? C.seafoam : C.gray, fill: { color: i % 2 === 0 ? C.white : C.light }, align: "center" } },
    ]),
    { x: 5.3, y: 1.85, w: 4.05, colW: [3.05, 1], rowH: 0.22, border: { pt: 0.5, color: "E2E8F0" } }
  );

  // Key metrics at bottom
  s.addText("15,475 能力  |  210 产品  |  KooCLI v7.2.12  |  E2E 5/5 通过", {
    x: 0.6, y: 5.05, w: 9, h: 0.4, fontSize: 11, fontFace: "Arial", color: C.gray, align: "center", margin: 0,
  });
}

// ─── Write ──────────────────────────────────────────────
pres.writeFile({ fileName: "/home/developer/Desktop/huaweicloud-mate/华为云Agent插件汇报.pptx" })
  .then(() => console.log("✅ PPT saved: 华为云Agent插件汇报.pptx"))
  .catch((e) => console.error("❌", e.message));
