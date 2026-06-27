import type { AggregatedStats, InsightsConfig, SessionFacet } from "./types.ts"

export interface ReportData {
  stats: AggregatedStats
  facets: Map<string, SessionFacet>
  aggregates: Record<string, unknown>
  atAGlance: Record<string, unknown>
  config: InsightsConfig
  generatedAt: number
}

// ── Escaping & formatting ─────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function fmtDate(input: number | string): string {
  const d = typeof input === "number" ? new Date(input) : new Date(input)
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function unavailable(): string {
  return `<p class="muted">(analysis unavailable)</p>`
}

function isEmptyObject(v: unknown): boolean {
  return v == null || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
}

// ── Component helpers ─────────────────────────────────────────────────────────

function barChart(
  title: string,
  items: Array<{ label: string; value: number; fmt?: string }>,
  color = "var(--clay)",
): string {
  // Drop zero-value rows: an empty bar + "0"/"$0.0000" + a (often truncated) label
  // is three redundant "this did nothing" signals that just add noise.
  const visible = items.filter((i) => i.value > 0)
  if (!visible.length) return ""
  const max = Math.max(...visible.map((i) => i.value), 1)
  const rows = visible
    .map((i) => {
      const pct = Math.round((i.value / max) * 100)
      const display = esc(i.fmt ?? String(i.value))
      return `<div class="bar-row">
      <span class="bar-label">${esc(i.label)}</span>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="bar-value">${display}</span>
    </div>`
    })
    .join("")
  // role="img" + aria-label gives assistive tech the full data in one readable
  // string; the decorative track divs are hidden so they aren't announced.
  const summary = visible.map((i) => `${i.label}: ${i.fmt ?? i.value}`).join(", ")
  return `<div class="bar-chart" role="img" aria-label="${esc(`${title} — ${summary}`)}">
    <div class="bar-chart-title" aria-hidden="true">${esc(title)}</div>
    ${rows}
  </div>`
}

function effortBadge(effort: unknown): string {
  const e = String(effort ?? "").toLowerCase()
  const cls = e === "low" ? "badge-low" : e === "high" ? "badge-high" : "badge-medium"
  return `<span class="badge ${cls}">${esc(e || "?")}</span>`
}

function simpleList(items: unknown[]): string {
  if (!items.length) return ""
  return `<ul class="list-simple">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
}

function keyInsight(text: unknown): string {
  if (!text) return ""
  return `<div class="key-insight">${esc(text)}</div>`
}

// ── Section renderers ─────────────────────────────────────────────────────────

// Render a glance value that may be a plain string (legacy reports) or an object
// with labeled sub-parts (current: actor-attributed split). Empty sub-parts are skipped.
function renderGlanceBody(val: unknown, subLabels: Array<[string, string]>): string {
  if (val == null) return unavailable()
  if (typeof val === "string") return val.trim() ? esc(val) : unavailable()
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>
    const parts = subLabels
      .map(([key, label]) => {
        const sub = obj[key]
        if (typeof sub !== "string" || !sub.trim()) return ""
        return `<div class="glance-sub"><span class="glance-sub-label">${label}:</span> ${esc(sub)}</div>`
      })
      .filter(Boolean)
    return parts.length ? parts.join("") : unavailable()
  }
  return esc(val)
}

function renderAtAGlance(atAGlance: Record<string, unknown>): string {
  const glanceItem = (key: string, label: string, subLabels: Array<[string, string]> = []) => {
    const content = renderGlanceBody(atAGlance[key], subLabels)
    return `<div class="glance-item">
      <div class="glance-label">${label}</div>
      <div>${content}</div>
    </div>`
  }
  return `<div class="at-a-glance">
    ${glanceItem("whats_working", "What's Working", [
      ["your_direction", "Your Direction"],
      ["agent_execution", "Your Agent's Execution"],
    ])}
    ${glanceItem("whats_hindering", "What's Hindering", [
      ["agent", "Agent"],
      ["user_side", "User-side"],
      ["tooling", "Tooling &amp; Environment"],
    ])}
    ${glanceItem("quick_wins", "Quick Wins")}
    ${glanceItem("ambitious_workflows", "Ambitious Workflows")}
  </div>`
}

function renderProjectAreas(agg: unknown): string {
  if (isEmptyObject(agg)) return unavailable()
  const data = agg as {
    areas?: Array<{
      name: string
      description: string
      session_count: number
      example_goals?: string[]
    }>
  }
  if (!data.areas?.length) return unavailable()
  return data.areas
    .map(
      (a) => `
    <div class="card" style="margin:8px 0">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <strong>${esc(a.name)}</strong>
        <span class="tag">${esc(a.session_count)} sessions</span>
      </div>
      <p style="margin:0 0 6px">${esc(a.description)}</p>
      ${a.example_goals?.length ? `<div>${a.example_goals.map((g) => `<span class="tag">${esc(g)}</span>`).join("")}</div>` : ""}
    </div>`,
    )
    .join("")
}

function renderAgentPerformance(agg: unknown, stats: AggregatedStats): string {
  const chart = stats.topAgents.length
    ? barChart(
        "Agent usage (sessions)",
        stats.topAgents.map((a) => ({ label: a.agent, value: a.count })),
      )
    : ""

  if (isEmptyObject(agg)) return chart || unavailable()
  const data = agg as {
    top_performers?: Array<{ agent: string; strength: string; usage_pattern: string }>
    cost_insights?: string[]
    model_pairing_tips?: string[]
    efficiency_opportunities?: string[]
  }

  const performers = data.top_performers?.length
    ? data.top_performers
        .map(
          (p) => `
        <div class="card" style="margin:8px 0">
          <strong>${esc(p.agent)}</strong>
          <p style="margin:4px 0">${esc(p.strength)}</p>
          <span class="muted">${esc(p.usage_pattern)}</span>
        </div>`,
        )
        .join("")
    : ""

  const costInsights = data.cost_insights?.length ? `<h3>Cost Insights</h3>${simpleList(data.cost_insights)}` : ""

  const modelTips = data.model_pairing_tips?.length
    ? `<h3>Model Pairing Tips</h3>${simpleList(data.model_pairing_tips)}`
    : ""

  const efficiency = data.efficiency_opportunities?.length
    ? `<h3>Efficiency Opportunities</h3>${simpleList(data.efficiency_opportunities)}`
    : ""

  return chart + performers + costInsights + modelTips + efficiency || unavailable()
}

function renderCostIntelligence(stats: AggregatedStats): string {
  // byAgentModel has one row per (agent, model); consolidate cost by model name.
  const costByModel = new Map<string, number>()
  for (const r of stats.byAgentModel) {
    costByModel.set(r.model, (costByModel.get(r.model) ?? 0) + r.cost)
  }
  const modelChart = costByModel.size
    ? barChart(
        "Cost by model",
        Array.from(costByModel.entries())
          .sort(([, a], [, b]) => b - a)
          .slice(0, 8)
          .map(([model, cost]) => ({ label: model, value: cost, fmt: fmtCost(cost) })),
        "var(--olive)",
      )
    : ""

  const cacheChart = stats.cacheEfficiency.length
    ? barChart(
        "Cache hit ratio by model",
        stats.cacheEfficiency.map((r) => ({
          label: r.model,
          value: r.cacheRatio,
          fmt: fmtPct(r.cacheRatio),
        })),
        "var(--olive)",
      )
    : ""

  const costPer1kRows = stats.costPer1k.length
    ? `<h3>Cost per 1k tokens</h3><div class="stats-grid">${stats.costPer1k
        .map(
          (r) => `
        <div class="stat">
          <div class="stat-label">${esc(r.model)}</div>
          <div class="stat-value" style="font-size:16px">${esc(fmtCost(r.costPer1kTokens))}</div>
        </div>`,
        )
        .join("")}</div>`
    : ""

  return modelChart + cacheChart + costPer1kRows || unavailable()
}

function renderInteractionAndFriction(interaction: unknown, friction: unknown): string {
  let out = ""

  // Interaction style: one observable pattern + actionable growth areas.
  // The prose "narrative" and "strengths" fields were removed from the schema
  // entirely (buildInteractionStylePrompt) — they psychoanalysed the user without
  // adding actionable signal. Only key_patterns + growth_areas are produced now.
  if (!isEmptyObject(interaction)) {
    const d = interaction as {
      key_patterns?: string[]
      growth_areas?: string[]
    }
    if (d.key_patterns?.length) out += keyInsight(d.key_patterns[0])
    if (d.growth_areas?.length) out += `<h3>Growth Areas</h3>${simpleList(d.growth_areas)}`
  }

  // Friction items
  if (!isEmptyObject(friction)) {
    const d = friction as {
      intro?: string
      categories?: Array<{ category: string; description: string; examples?: string[] }>
    }
    if (out) out += `<hr style="border:none;border-top:var(--border);margin:20px 0">`
    if (d.intro) out += `<p>${esc(d.intro)}</p>`
    if (d.categories?.length) {
      out += d.categories
        .map(
          (c) => `
        <div class="friction-item">
          <strong>${esc(c.category)}</strong>
          <p style="margin:4px 0">${esc(c.description)}</p>
          ${c.examples?.length ? `<ul style="margin:4px 0;padding-left:18px">${c.examples.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
        </div>`,
        )
        .join("")
    }
  }

  return out || unavailable()
}

function renderSuggestions(agg: unknown): string {
  if (isEmptyObject(agg)) return unavailable()
  const data = agg as {
    agents_md_additions?: Array<{ rule: string; rationale: string; why_now: string }>
    features_to_try?: Array<{
      feature: string
      one_liner: string
      why_for_you: string
      example: string
    }>
    workflow_patterns?: Array<{
      pattern: string
      benefit: string
      how_to: string
      copyable_prompt: string
    }>
  }

  let out = ""

  if (data.agents_md_additions?.length) {
    out += "<h3>AGENTS.md Additions</h3>"
    out += data.agents_md_additions
      .map(
        (s) => `
      <div class="card" style="margin:8px 0">
        <strong>${esc(s.rule)}</strong>
        <p style="margin:4px 0">${esc(s.rationale)}</p>
        <span class="muted">${esc(s.why_now)}</span>
      </div>`,
      )
      .join("")
  }

  if (data.features_to_try?.length) {
    out += "<h3>Features to Try</h3>"
    out += data.features_to_try
      .map(
        (f) => `
      <div class="card" style="margin:8px 0">
        <strong>${esc(f.feature)}</strong> — ${esc(f.one_liner)}
        <p style="margin:4px 0">${esc(f.why_for_you)}</p>
        <pre>${esc(f.example)}</pre>
      </div>`,
      )
      .join("")
  }

  if (data.workflow_patterns?.length) {
    out += "<h3>Workflow Patterns</h3>"
    out += data.workflow_patterns
      .map(
        (w) => `
      <div class="card" style="margin:8px 0">
        <strong>${esc(w.pattern)}</strong> — ${esc(w.benefit)}
        <p style="margin:4px 0">${esc(w.how_to)}</p>
        <pre>${esc(w.copyable_prompt)}</pre>
      </div>`,
      )
      .join("")
  }

  return out || unavailable()
}

function renderDelegationTopology(stats: AggregatedStats): string {
  if (!stats.agentDelegation.length) {
    return `<p class="muted">No agent delegation recorded in this period.</p>`
  }

  const chart = barChart(
    "Delegations by agent pair",
    stats.agentDelegation.map((d) => ({
      label: `${d.parentAgent} → ${d.childAgent}`,
      value: d.count,
    })),
    "var(--g500)",
  )

  // Summary stats
  const totalDelegations = stats.agentDelegation.reduce((s, d) => s + d.count, 0)
  const uniquePairs = stats.agentDelegation.length
  const statsRow = `<div class="stats-grid" style="margin-bottom:16px">
    <div class="stat"><div class="stat-label">Delegations</div><div class="stat-value">${totalDelegations}</div></div>
    <div class="stat"><div class="stat-label">Agent Pairs</div><div class="stat-value">${uniquePairs}</div></div>
  </div>`

  return statsRow + chart
}

function renderToolHealth(agg: unknown, stats: AggregatedStats): string {
  const chart = stats.topTools.length
    ? barChart(
        "Tool usage (calls)",
        stats.topTools.map((t) => ({ label: t.tool, value: t.count })),
      )
    : ""

  // Error rate sub-chart if data exists
  const errorChart = stats.toolErrorRates.filter((t) => t.errorRate > 0).length
    ? barChart(
        "Error rate by tool",
        stats.toolErrorRates
          .filter((t) => t.errorRate > 0)
          .sort((a, b) => b.errorRate - a.errorRate)
          .slice(0, 6)
          .map((t) => ({ label: t.tool, value: t.errorRate, fmt: fmtPct(t.errorRate) })),
        "var(--rust)",
      )
    : ""

  if (isEmptyObject(agg)) return chart + errorChart || unavailable()
  const data = agg as {
    problematic_tools?: Array<{ tool: string; error_rate: string; likely_cause: string }>
    efficiency_tips?: string[]
    recovery_patterns?: string[]
  }

  const problemTools = data.problematic_tools?.length
    ? data.problematic_tools
        .map(
          (t) => `
        <div class="friction-item">
          <strong>${esc(t.tool)}</strong>
          <span class="tag" style="border-color:var(--rust);color:var(--rust)">${esc(t.error_rate)}</span>
          <p style="margin:4px 0">${esc(t.likely_cause)}</p>
        </div>`,
        )
        .join("")
    : ""

  const effTips = data.efficiency_tips?.length ? `<h3>Efficiency Tips</h3>${simpleList(data.efficiency_tips)}` : ""

  const recovery = data.recovery_patterns?.length
    ? `<h3>Recovery Patterns</h3>${simpleList(data.recovery_patterns)}`
    : ""

  return chart + errorChart + problemTools + effTips + recovery || unavailable()
}

function renderHorizon(agg: unknown): string {
  if (isEmptyObject(agg)) return unavailable()
  const data = agg as {
    automation_opportunities?: Array<{ opportunity: string; how: string; effort: string }>
    skill_gaps?: string[]
    workflow_evolutions?: string[]
  }

  let out = ""

  if (data.automation_opportunities?.length) {
    out += "<h3>Automation Opportunities</h3>"
    out += data.automation_opportunities
      .map(
        (o) => `
      <div class="card" style="margin:8px 0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
          <strong>${esc(o.opportunity)}</strong>
          ${effortBadge(o.effort)}
        </div>
        <p style="margin:0">${esc(o.how)}</p>
      </div>`,
      )
      .join("")
  }

  if (data.skill_gaps?.length) out += `<h3>Skill Gaps</h3>${simpleList(data.skill_gaps)}`
  if (data.workflow_evolutions?.length) out += `<h3>Workflow Evolutions</h3>${simpleList(data.workflow_evolutions)}`

  return out || unavailable()
}

function renderRoomToLearn(agg: unknown): string {
  if (isEmptyObject(agg)) return unavailable()
  const data = agg as {
    intro?: string
    areas?: Array<{ topic: string; type?: string; rationale: string; first_step?: string }>
  }
  if (!data.areas?.length) return unavailable()

  let out = data.intro ? `<p>${esc(data.intro)}</p>` : ""
  out += data.areas
    .map(
      (a) => `
    <div class="card" style="margin:8px 0">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
        <strong>${esc(a.topic)}</strong>
        ${a.type ? `<span class="tag">${esc(a.type)}</span>` : ""}
      </div>
      <p style="margin:0 0 6px">${esc(a.rationale)}</p>
      ${a.first_step ? `<div class="learn-step"><span class="learn-step-label">Start here:</span> ${esc(a.first_step)}</div>` : ""}
    </div>`,
    )
    .join("")

  return out || unavailable()
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
:root{
  --ivory:#FAF9F5; --paper:#FFFFFF;
  --g100:#F0EEE6; --g200:#E6E3DA; --g300:#D1CFC5; --g500:#6A6960; --g700:#3D3D3A;
  --slate:#141413; --clay:#D97757; --clay-d:#B85C3E; --clay-text:#9C4A2E; --rust:#B04A3F; --olive:#788C5D; --olive-text:#5F7048; --oat:#E3DACC;
  --serif:ui-serif,Georgia,"Times New Roman",Times,serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace;
  --radius-panel:12px; --radius-row:8px; --border:1.5px solid var(--g300);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ivory);color:var(--slate);font-family:var(--sans);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:40px 24px 120px}
h1{font-family:var(--serif);font-weight:500;font-size:36px;letter-spacing:-.01em;line-height:1.2;margin:0 0 6px}
h2{font-family:var(--serif);font-weight:500;font-size:22px;letter-spacing:-.01em;margin:0 0 16px}
h3{font-family:var(--serif);font-weight:500;font-size:16px;margin:20px 0 6px}
hr{border:none;border-top:var(--border);margin:24px 0}
a{color:var(--clay);text-decoration:none}a:hover{color:var(--clay-d);text-decoration:underline}
code,pre{font-family:var(--mono);background:var(--g100);border-radius:6px}
code{padding:1px 5px;font-size:.86em}
pre{padding:12px 14px;overflow:auto;border:var(--border);white-space:pre-wrap;word-break:break-word;margin:8px 0}
.panel,.card{background:var(--paper);border:var(--border);border-radius:var(--radius-panel);padding:18px}
.muted{color:var(--g500)}
button{font:inherit;cursor:pointer;border:var(--border);background:var(--paper);color:var(--slate);border-radius:9px;padding:8px 14px}
button.primary{background:var(--clay);border-color:var(--clay);color:var(--paper);font-weight:600}
button:hover{filter:brightness(.97)}

/* Sticky nav */
.section-nav{position:sticky;top:0;background:var(--paper);border-bottom:var(--border);padding:10px 0;z-index:100}
.section-nav .inner{max-width:920px;margin:0 auto;padding:0 24px;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.section-nav a{font-size:12px;color:var(--g500);text-decoration:none;padding:4px 10px;border-radius:6px;white-space:nowrap;transition:color .15s}
.section-nav a:hover{color:var(--clay-text)}

/* Skip link (visible on keyboard focus) */
.skip-link{position:absolute;left:-9999px;top:0;background:var(--clay);color:var(--paper);padding:8px 14px;border-radius:0 0 8px 0;z-index:200;font-weight:600}
.skip-link:focus{left:0}

/* Page sections */
section{margin:40px 0}
section[id]{scroll-margin-top:52px}
.section-header{display:flex;align-items:baseline;gap:12px;margin-bottom:16px;padding-bottom:10px;border-bottom:var(--border)}
.section-header h2{margin:0}

/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:16px 0}
.stat{background:var(--paper);border:var(--border);border-radius:var(--radius-row);padding:12px 16px}
.stat-label{font-size:11px;color:var(--g500);text-transform:uppercase;letter-spacing:.06em}
.stat-value{font-size:22px;font-weight:600;color:var(--slate);font-family:var(--mono)}

/* At a glance */
.at-a-glance{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:8px 0}
@media(max-width:600px){.at-a-glance{grid-template-columns:1fr}}
.glance-item{background:var(--paper);border:var(--border);border-radius:var(--radius-panel);padding:16px}
.glance-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--clay-text);margin-bottom:8px}
.glance-sub{margin:6px 0}
.glance-sub-label{font-weight:600;color:var(--g700)}

/* Bar chart */
.bar-chart{margin:16px 0}
.bar-chart-title{font-size:11px;color:var(--g500);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
.bar-row{display:grid;grid-template-columns:150px 1fr auto;align-items:center;gap:12px;margin-bottom:9px}
.bar-label{font-size:12px;color:var(--g700);text-align:right;line-height:1.3;overflow-wrap:anywhere}
.bar-track{height:10px;background:var(--g100);border-radius:5px;overflow:hidden;min-width:36px}
.bar-fill{height:100%;border-radius:5px}
.bar-value{font-size:12px;color:var(--g700);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
@media(max-width:768px){
  .bar-row{grid-template-columns:1fr auto;column-gap:12px;row-gap:4px}
  .bar-label{grid-column:1 / -1;text-align:left}
}

/* Key insight */
.key-insight{background:var(--oat);border-left:3px solid var(--clay);padding:12px 16px;margin:12px 0;border-radius:0 6px 6px 0;font-size:14px;color:var(--g700)}

/* Friction */
.friction-item{border-left:3px solid var(--rust);padding:6px 0 6px 14px;margin:10px 0}

/* Room to Learn */
.learn-step{font-size:14px;color:var(--g700)}
.learn-step-label{font-weight:600;color:var(--clay-text)}

/* Tag & badge */
.tag{display:inline-block;background:var(--g100);border:var(--border);border-radius:4px;padding:2px 8px;font-size:12px;margin:2px}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:4px;border:1.5px solid currentColor}
.badge-low{color:var(--olive-text)}
.badge-medium{color:var(--clay-text)}
.badge-high{color:var(--rust)}

/* Simple list */
.list-simple{list-style:none;padding:0;margin:8px 0}
.list-simple li{padding:5px 0;border-bottom:1px solid var(--g100);font-size:14px;color:var(--g700)}
.list-simple li:last-child{border-bottom:none}
.list-simple li::before{content:"→\\00a0";color:var(--clay)}

/* Collapsible sections (native <details>) */
.section{margin:0}
summary.section-header{cursor:pointer;align-items:center;list-style:none}
summary.section-header::-webkit-details-marker{display:none}
summary.section-header::after{content:"";margin-left:auto;width:8px;height:8px;border-right:2px solid var(--g500);border-bottom:2px solid var(--g500);transform:rotate(-45deg);transition:transform .2s;flex:none}
details[open] > summary.section-header::after{transform:rotate(45deg)}
summary.section-header:hover{color:var(--clay-text)}
summary.section-header:hover::after{border-color:var(--clay)}
summary.section-header:focus-visible{outline:2px solid var(--clay);outline-offset:2px}

/* Action bar */
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0}
.nav-toggle{margin-left:auto;font-size:12px;padding:3px 12px;border-radius:6px}

/* Opt-in dark mode — warm token overrides, accents kept */
:root[data-theme="dark"]{
  --ivory:#1A1917; --paper:#211F1C; --g100:#272521; --g200:#302D28; --g300:#3C3833;
  --g500:#9A968C; --g700:#CFCABD; --slate:#F2EFE8; --oat:#3A332A;
  --clay-text:#E0916F; --olive-text:#9DB47E;
}
`

// ── Main export ───────────────────────────────────────────────────────────────

export function generateReport(data: ReportData, insightsJson: string): string {
  const { stats, aggregates, atAGlance } = data
  const dateFrom = fmtDate(stats.dateRange.from)
  const dateTo = fmtDate(stats.dateRange.to)

  const safeJson = insightsJson.replace(/</g, "\\u003c")

  const navLinks = [
    ["#at-a-glance", "At a Glance"],
    ["#project-areas", "Project Areas"],
    ["#agent-performance", "Agent Performance"],
    ["#cost", "Cost Intelligence"],
    ["#interaction-friction", "Interaction &amp; Friction"],
    ["#suggestions", "Suggestions"],
    ["#delegation", "Delegation"],
    ["#tool-health", "Tool Health"],
    ["#room-to-learn", "Room to Learn"],
    ["#horizon", "On the Horizon"],
  ]
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join("")

  const section = (id: string, title: string, content: string) => `
  <section id="${id}">
    <details class="section" open>
      <summary class="section-header"><h2>${title}</h2></summary>
      <div class="panel">${content}</div>
    </details>
  </section>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opencode-X Insights</title>
<script>try{if((localStorage.getItem('theme')||'light')==='dark')document.documentElement.dataset.theme='dark';}catch(e){}</script>
<style>${CSS}</style>
</head>
<body>

<a class="skip-link" href="#main-content">Skip to content</a>

<nav class="section-nav" aria-label="Report sections">
  <div class="inner">${navLinks}<button id="theme-toggle" class="nav-toggle" type="button" aria-label="Toggle dark mode">Dark</button></div>
</nav>

<main class="wrap" id="main-content">

  <h1>Opencode-X Insights</h1>
  <p class="muted">${esc(dateFrom)} – ${esc(dateTo)}</p>

  <div class="stats-grid">
    <div class="stat">
      <div class="stat-label">Sessions</div>
      <div class="stat-value">${esc(stats.totalSessions)} (${esc(stats.childSessions)} sub)</div>
    </div>
    <div class="stat">
      <div class="stat-label">Analyzed</div>
      <div class="stat-value">${esc(stats.analyzedSessions)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Tokens</div>
      <div class="stat-value">${esc(fmtTokens(stats.totalTokens))}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Cost</div>
      <div class="stat-value">${esc(fmtCost(stats.totalCost))}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Messages</div>
      <div class="stat-value">${esc(fmtTokens(stats.totalMessages))}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Top Model</div>
      <div class="stat-value" style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">${esc(stats.topModels[0]?.model ?? "–")}</div>
    </div>
  </div>

  <div class="actions">
    <button class="primary" type="button" onclick="exportJson()">Export insights.json</button>
    <button type="button" onclick="toggleAll(true)">Expand all</button>
    <button type="button" onclick="toggleAll(false)">Collapse all</button>
  </div>

  <section id="at-a-glance">
    <details class="section" open>
      <summary class="section-header"><h2>At a Glance</h2></summary>
      ${renderAtAGlance(atAGlance)}
    </details>
  </section>

  ${section("project-areas", "Project Areas", renderProjectAreas(aggregates.project_areas))}
  ${section("agent-performance", "Agent Performance", renderAgentPerformance(aggregates.agent_performance, stats))}
  ${section("cost", "Cost Intelligence", renderCostIntelligence(stats))}
  ${section("interaction-friction", "Interaction &amp; Friction", renderInteractionAndFriction(aggregates.interaction_style, aggregates.friction))}
  ${section("suggestions", "Suggestions", renderSuggestions(aggregates.suggestions))}
  ${section("delegation", "Delegation Topology", renderDelegationTopology(stats))}
  ${section("tool-health", "Tool Health", renderToolHealth(aggregates.tool_health, stats))}
  ${section("room-to-learn", "Room to Learn", renderRoomToLearn(aggregates.room_to_learn))}
  ${section("horizon", "On the Horizon", renderHorizon(aggregates.horizon))}


</main>

<script type="application/json" id="insights-data">${safeJson}</script>
<script>
function exportJson() {
  const data = document.getElementById('insights-data').textContent;
  const blob = new Blob([data], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'insights.json';
  a.click();
}
function toggleAll(open) {
  document.querySelectorAll('details.section').forEach((d) => { d.open = open; });
}
(function () {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const sync = () => { btn.textContent = root.dataset.theme === 'dark' ? 'Light' : 'Dark'; };
  btn.addEventListener('click', () => {
    const dark = root.dataset.theme === 'dark';
    root.dataset.theme = dark ? '' : 'dark';
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) {}
    sync();
  });
  sync();
})();
</script>
</body>
</html>`
}
