const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "张冉冉";
pres.title = "华为云 Agent 插件 huaweicloud-mate";

// ─── Color Palette ───
const C = {
  teal: "028090",    dark: "1A1A2E",    white: "FFFFFF",
  seafoam: "00A896", gray: "64748B",    light: "F0FDFA",
  mint: "5EEAD4",    slate: "334155",   cream: "F8FAFC",
  red: "EF4444",     amber: "F59E0B",   green: "10B981",
  indigo: "4F46E5",  purple: "7C3AED",
};
const makeShadow = () => ({ type: "outer", blur: 4, offset: 2, angle: 135, color: "000000", opacity: 0.08 });

// ══════════════════════════════════════════════════════════
// SLIDE 1 — Title
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.teal };
  s.addShape(pres.shapes.OVAL, { x: 7.5, y: -1.5, w: 5, h: 5, fill: { color: C.seafoam, transparency: 60 } });
  s.addShape(pres.shapes.OVAL, { x: 8.5, y: 2.5, w: 3, h: 3, fill: { color: C.mint, transparency: 70 } });

  s.addText("huaweicloud-mate", {
    x: 0.8, y: 1.0, w: 8, h: 1.2, fontSize: 46, fontFace: "Noto Sans CJK SC",
    color: C.white, bold: true, margin: 0,
  });
  s.addText("华为云 Agent 插件 — 完整架构框架", {
    x: 0.8, y: 2.3, w: 8, h: 0.7, fontSize: 22, fontFace: "Noto Sans CJK SC",
    color: C.mint, margin: 0,
  });
  s.addText("Skill · MCP · KooCLI · APIE · SDK · Terraform  六大组件统一集成", {
    x: 0.8, y: 3.1, w: 8, h: 0.5, fontSize: 13, fontFace: "Noto Sans CJK SC",
    color: C.cream, margin: 0,
  });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.8, y: 4.0, w: 3.5, h: 0.06, fill: { color: C.mint } });
  s.addText("一期 v1.2 已发布  |  10/12 完成  |  OpenCode 验证通过", {
    x: 0.8, y: 4.2, w: 8, h: 0.4, fontSize: 10, fontFace: "Noto Sans CJK SC", color: C.seafoam, margin: 0,
  });
}

// ══════════════════════════════════════════════════════════
// SLIDE 2 — Complete Architecture Framework
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  // Title
  s.addText("插件完整架构框架", { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 24, fontFace: "Noto Sans CJK SC", color: C.dark, margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 0.75, w: 0.6, h: 0.04, fill: { color: C.teal } });

  // ─── Top layer: Agent ───
  s.addShape(pres.shapes.RECTANGLE, { x: 2.0, y: 0.95, w: 6.0, h: 0.45, fill: { color: C.indigo } });
  s.addText("Agent 层  —  OpenCode  ·  Claude Code  ·  Codex  ·  华为云码道", {
    x: 2.0, y: 0.95, w: 6.0, h: 0.45, fontSize: 10, fontFace: "Noto Sans CJK SC", color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // Arrow
  s.addText("▼  MCP stdio JSON-RPC", { x: 3.5, y: 1.4, w: 3, h: 0.25, fontSize: 8, fontFace: "Noto Sans CJK SC", color: C.gray, align: "center", margin: 0 });

  // ─── Core: Router ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 1.65, w: 9.0, h: 1.35, fill: { color: C.light }, shadow: makeShadow() });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 1.65, w: 9.0, h: 0.04, fill: { color: C.teal } });
  s.addText("huaweicloud-mate Router (核心调度层)", {
    x: 0.7, y: 1.72, w: 5, h: 0.28, fontSize: 11, fontFace: "Noto Sans CJK SC", color: C.teal, margin: 0,
  });

  // 5 Tools row
  const tools = [
    { n: "①", name: "cloud_capability\nsearch", desc: "搜索能力" },
    { n: "②", name: "cloud_capability\ndescribe", desc: "获取详情" },
    { n: "③", name: "cloud_targets\nstatus", desc: "健康检查" },
    { n: "④", name: "cloud_action\nplan", desc: "风险审批" },
    { n: "⑤", name: "cloud_action\nexecute", desc: "分发执行" },
  ];
  tools.forEach((t, i) => {
    const x = 0.7 + i * 1.7;
    s.addShape(pres.shapes.RECTANGLE, { x: x, y: 2.05, w: 1.55, h: 0.85, fill: { color: C.white } });
    s.addText(t.n, { x: x + 0.05, y: 2.07, w: 0.3, h: 0.2, fontSize: 10, fontFace: "Noto Sans CJK SC", color: C.teal, margin: 0 });
    s.addText(t.name, { x: x + 0.05, y: 2.25, w: 1.45, h: 0.45, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0 });
    s.addText(t.desc, { x: x + 0.05, y: 2.7, w: 1.45, h: 0.15, fontSize: 7, fontFace: "Noto Sans CJK SC", color: C.gray, italic: true, margin: 0 });
  });

  // ─── Engine modules ───
  const modules = [
    { name: "Catalog", sub: "15,475 能力\n中文分词搜索", color: C.teal },
    { name: "Policy", sub: "风险分级\nplan_token", color: C.seafoam },
    { name: "Credential", sub: "~/.hcloud/\ncredentials", color: C.mint },
    { name: "Audit", sub: "JSONL\n审计日志", color: C.indigo },
    { name: "KooCLI\nInstaller", sub: "自动下载\nSHA256校验", color: C.purple },
  ];
  modules.forEach((m, i) => {
    const x = 0.7 + i * 1.7;
    s.addShape(pres.shapes.RECTANGLE, { x: x, y: 2.92, w: 1.55, h: 0.5, fill: { color: m.color, transparency: 85 } });
    s.addText(m.name, { x: x + 0.05, y: 2.94, w: 0.8, h: 0.2, fontSize: 8, fontFace: "Noto Sans CJK SC", bold: true, color: m.color, margin: 0 });
    s.addText(m.sub, { x: x + 0.85, y: 2.94, w: 0.65, h: 0.46, fontSize: 6, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0 });
  });

  // ─── Execution layer ───
  s.addText("▼  执行器矩阵", { x: 3.8, y: 3.45, w: 2.5, h: 0.2, fontSize: 8, fontFace: "Noto Sans CJK SC", color: C.gray, align: "center", margin: 0 });

  const execs = [
    { name: "MCP 🟢", sub: "ecs-mock/obs/nat\nMetaMCP 管理(二期)", w: 2.2, color: C.green },
    { name: "KooCLI 🟢", sub: "210 产品全覆盖\nv7.2.12 子进程", w: 2.2, color: C.teal },
    { name: "APIE 🟡", sub: "OpenAPI 数据源\nCatalog 自动构建(二期)", w: 2.2, color: C.amber },
    { name: "SDK ⚪", sub: "进程内调用\n二期实现", w: 2.2, color: C.gray },
    { name: "Terraform ⚪", sub: "资源编排\n二期实现", w: 2.2, color: C.gray },
  ];
  execs.forEach((e, i) => {
    const x = 0.5 + i * 1.85;
    s.addShape(pres.shapes.RECTANGLE, { x: x, y: 3.65, w: 1.7, h: 0.7, fill: { color: C.white }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: x, y: 3.65, w: 1.7, h: 0.04, fill: { color: e.color } });
    s.addText(e.name, { x: x + 0.08, y: 3.72, w: 1.54, h: 0.2, fontSize: 8, fontFace: "Noto Sans CJK SC", bold: true, color: C.dark, margin: 0 });
    s.addText(e.sub, { x: x + 0.08, y: 3.95, w: 1.54, h: 0.35, fontSize: 6.5, fontFace: "Noto Sans CJK SC", color: C.gray, margin: 0 });
  });

  // ─── Cloud layer ───
  s.addText("▼", { x: 4.8, y: 4.4, w: 0.4, h: 0.2, fontSize: 10, color: C.gray, align: "center", margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 1.0, y: 4.55, w: 8.0, h: 0.45, fill: { color: C.dark } });
  s.addText("☁️  华为云  —  ECS · OBS · VPC · IAM · RDS · ELB · NAT · DNS · ... 210 产品", {
    x: 1.0, y: 4.55, w: 8.0, h: 0.45, fontSize: 10, fontFace: "Noto Sans CJK SC", color: C.white, align: "center", valign: "middle", margin: 0,
  });

  // Legend
  s.addText("🟢 一期已完成    🟡 二期进行中    ⚪ 二期规划", {
    x: 0.5, y: 5.15, w: 9, h: 0.3, fontSize: 8, fontFace: "Noto Sans CJK SC", color: C.gray, align: "center", margin: 0,
  });
}

// ══════════════════════════════════════════════════════════
// SLIDE 3 — Key Features & Characteristics  
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  s.addText("插件核心特点", { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 24, fontFace: "Noto Sans CJK SC", color: C.dark, margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 0.75, w: 0.6, h: 0.04, fill: { color: C.teal } });

  const features = [
    { icon: "01", title: "Agent 友好 — 固定 5 工具面",
      desc: "Agent 只看到 5 个元工具，不暴露成百上千的产品 Tool。通过语义搜索按需展开能力，避免上下文膨胀。" },
    { icon: "02", title: "六大组件统一集成",
      desc: "Skill(指导) + MCP(工具) + KooCLI(命令) + APIE(发现) + SDK(编程) + Terraform(声明) — 一个插件覆盖所有华为云操作方式。" },
    { icon: "03", title: "双执行器自动回退",
      desc: "Agent 默认走 MCP(语义丰富)，MCP 不可用时自动切换 KooCLI(200+ 服务全覆盖)。读操作自动降级，副作用操作锁定执行器。" },
    { icon: "04", title: "全量能力覆盖 — 15,475 操作",
      desc: "Catalog 包含 210 产品的 15,475 个操作，每个操作标注风险级别(read/cost/destructive)。Agent 秒级搜索匹配。" },
    { icon: "05", title: "一键安装 + KooCLI 自举",
      desc: "npm install 后，首次启动自动下载 KooCLI(SHA256校验)，用户无需手动安装任何依赖。插件启动即用。" },
    { icon: "06", title: "安全纵深防御",
      desc: "AK/SK 仅存 ~/.hcloud/credentials(0600权限)；KooCLI 子进程环境变量注入，ps aux 不可见；输出实时脱敏；JSONL 全链路审计。" },
    { icon: "07", title: "产品部可自主接入",
      desc: "产品部基于 APIE OpenAPI → FastMCP 自动生成 MCP Server → 注册到 Catalog。插件团队只做集成，不做内容。" },
    { icon: "08", title: "多 Agent 适配",
      desc: "OpenCode / Claude Code / Codex / 华为云码道 — 一套 Router，4 套薄适配器。Agent 侧只需一行 MCP 配置。" },
  ];

  features.forEach((f, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.5 + col * 4.7;
    const y = 1.0 + row * 1.02;

    s.addShape(pres.shapes.RECTANGLE, { x: x, y: y, w: 4.4, h: 0.9, fill: { color: C.light }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: x, y: y, w: 0.06, h: 0.9, fill: { color: C.teal } });

    s.addText(f.icon, {
      x: x + 0.2, y: y + 0.05, w: 0.4, h: 0.35, fontSize: 16, fontFace: "Noto Sans CJK SC", color: C.teal, margin: 0,
    });
    s.addText(f.title, {
      x: x + 0.7, y: y + 0.05, w: 3.5, h: 0.28, fontSize: 11, fontFace: "Noto Sans CJK SC", bold: true, color: C.dark, margin: 0,
    });
    s.addText(f.desc, {
      x: x + 0.7, y: y + 0.35, w: 3.5, h: 0.52, fontSize: 7.5, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0,
    });
  });
}

// ══════════════════════════════════════════════════════════
// SLIDE 4 — Phase 1 vs Phase 2
// ══════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.white };

  s.addText("一期 vs 二期规划", { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 24, fontFace: "Noto Sans CJK SC", color: C.dark, margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 0.75, w: 0.6, h: 0.04, fill: { color: C.teal } });

  // ─── Left: Phase 1 ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 1.0, w: 4.2, h: 3.5, fill: { color: C.light }, shadow: makeShadow() });
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 1.0, w: 4.2, h: 0.04, fill: { color: C.green } });
  s.addText("一期 v1.2  ✅ 已完成", {
    x: 0.7, y: 1.1, w: 3.8, h: 0.35, fontSize: 13, fontFace: "Noto Sans CJK SC", color: C.green, margin: 0,
  });

  const p1Items = [
    "Router 5 工具 (MCP stdio)",
    "Catalog 15,475 能力 / 210 产品",
    "KooCLI 自动安装 v7.2.12",
    "MCP + KooCLI 双执行器路由",
    "MCP 健康检查 (3 servers)",
    "~/.hcloud/credentials",
    "JSONL 审计日志",
    "Mock MCP Server (ECS)",
    "真实 MCP 接入 (OBS/NAT)",
    "OpenCode E2E 5/5 通过",
    "APIE → KooCLI 全量扫描",
  ];
  p1Items.forEach((item, i) => {
    s.addText("✓  " + item, {
      x: 0.7, y: 1.5 + i * 0.26, w: 3.8, h: 0.24, fontSize: 8.5, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0,
    });
  });

  // ─── Right: Phase 2 ───
  s.addShape(pres.shapes.RECTANGLE, { x: 5.3, y: 1.0, w: 4.2, h: 3.5, fill: { color: C.light }, shadow: makeShadow() });
  s.addShape(pres.shapes.RECTANGLE, { x: 5.3, y: 1.0, w: 4.2, h: 0.04, fill: { color: C.amber } });
  s.addText("二期 v2.0  ⏳ 规划中", {
    x: 5.5, y: 1.1, w: 3.8, h: 0.35, fontSize: 13, fontFace: "Noto Sans CJK SC", color: C.amber, margin: 0,
  });

  const p2Items = [
    { item: "MetaMCP 管理多 MCP Server", done: "⏳" },
    { item: "APIE 在线拉取 OpenAPI", done: "⏳" },
    { item: "Catalog 自动构建 (参数完整)", done: "⏳" },
    { item: "SDK 进程内执行器", done: "○" },
    { item: "Terraform plan→apply 工作流", done: "○" },
    { item: "KooCLI 在线更新", done: "○" },
    { item: "Skill 注入 Agent prompt", done: "○" },
    { item: "TF State 管理", done: "○" },
    { item: "OS Keychain 凭证 (二期)", done: "○" },
    { item: "多 Agent 共享 Router 进程", done: "○" },
    { item: "npm publish 公开发布", done: "○" },
  ];
  p2Items.forEach((item, i) => {
    s.addText(`${item.done}  ${item.item}`, {
      x: 5.5, y: 1.5 + i * 0.26, w: 3.8, h: 0.24, fontSize: 8.5, fontFace: "Noto Sans CJK SC", color: C.slate, margin: 0,
    });
  });

  // ─── Bottom: Metrics ───
  s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 4.75, w: 9.0, h: 0.55, fill: { color: C.teal } });
  const metrics = "15,475 能力  |  210 产品  |  1,847 行代码  |  KooCLI v7.2.12  |  E2E 5/5 通过  |  OpenCode 已验证";
  s.addText(metrics, {
    x: 0.5, y: 4.75, w: 9.0, h: 0.55, fontSize: 10, fontFace: "Noto Sans CJK SC", color: C.white, align: "center", valign: "middle", margin: 0,
  });
}

// ─── Write ──────────────────────────────────────────────
pres.writeFile({ fileName: "/home/developer/Desktop/huaweicloud-mate/华为云Agent插件-完整框架.pptx" })
  .then(() => console.log("✅ PPT saved: 华为云Agent插件-完整框架.pptx"))
  .catch((e) => console.error("❌", e.message));
