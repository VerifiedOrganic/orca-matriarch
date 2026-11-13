// Surfaces, borders and text follow Orca's theme. Matriarch's colors (lanes, dots, the primary
// button, links) are its own, with light and dark variants: many Orca themes make `primary` black or
// white, which would leave every lane the same color.
export const CSS = `
:root {
  --m-blue: #2563eb;
  --m-blue-fg: #ffffff;
  --m-red: #dc2626;
  --m-red-fg: #ffffff;
  --m-active: var(--m-blue);
  --m-waiting: color-mix(in srgb, var(--orca-muted-foreground) 55%, transparent);
  --m-fixing: #d97706;
  --m-review: #7c3aed;
  --m-blocked: var(--m-red);
  --m-ready: #059669;
  --m-quiet: color-mix(in srgb, var(--orca-muted-foreground) 25%, transparent);
  --m-done: color-mix(in srgb, var(--orca-muted-foreground) 70%, transparent);
}
html.dark {
  --m-blue: #60a5fa;
  --m-blue-fg: #0b0b0e;
  --m-red: #f87171;
  --m-red-fg: #0b0b0e;
  --m-fixing: #f59e0b;
  --m-review: #a78bfa;
  --m-ready: #34d399;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--orca-background); color: var(--orca-foreground);
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
button { font: inherit; color: inherit; background: var(--orca-secondary); border: 1px solid var(--orca-border);
  border-radius: var(--orca-radius, 6px); padding: 3px 8px; cursor: pointer; }
button:hover { background: var(--orca-accent); }
button.primary { background: var(--m-blue); color: var(--m-blue-fg); border-color: transparent; }
button.danger { background: var(--m-red); color: var(--m-red-fg); border-color: transparent; }
button.ghost { background: transparent; border-color: transparent; }
button[aria-pressed="true"] { background: var(--orca-accent); border-color: var(--orca-ring); }
a { color: var(--m-blue); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
.app { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.title { font-size: 14px; font-weight: 600; margin-right: auto; }
.muted { color: var(--orca-muted-foreground); }
.pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--orca-border); background: var(--orca-card); white-space: nowrap; font-size: 11px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
/* A long agent or model name wraps inside its card instead of running past it. */
.card .pill { white-space: normal; overflow-wrap: anywhere; max-width: 100%; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--orca-border); padding-bottom: 6px; align-items: center; }
.tabs .spacer { flex: 1; }
.callout { border: 1px solid var(--orca-border); border-left: 3px solid var(--m-blocked); background: var(--orca-card);
  border-radius: var(--orca-radius, 6px); padding: 6px 8px; }
.callout.warn { border-left-color: var(--m-fixing); }
.callout.attention { border-color: var(--m-blocked); }
.callout.attention li { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin: 4px 0; }
.callout.attention li button { flex: none; }
.callout ul { margin: 2px 0 0 16px; padding: 0; }
.supervisors { display: flex; flex-direction: column; gap: 6px; }
.sup { border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 6px); padding: 6px 8px; background: var(--orca-card); display: flex; flex-direction: column; gap: 4px; }
.sup-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sup-head .spacer { flex: 1; }
.sup summary { cursor: pointer; color: var(--m-blue); }
.sup-hint { color: var(--m-fixing); font-size: 11px; min-height: 0; }
.sup-hint:empty { display: none; }
.badge { font-size: 11px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--orca-border); white-space: nowrap; }
.badge-running { color: var(--m-ready); border-color: var(--m-ready); }
.badge-starting { color: var(--m-fixing); border-color: var(--m-fixing); }
.badge-idle { color: var(--orca-muted-foreground); }
.sup-form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.sup-form textarea { font: inherit; color: inherit; background: var(--orca-background); border: 1px solid var(--orca-input); border-radius: var(--orca-radius, 6px); padding: 6px; resize: vertical; }
.empty { border: 1px dashed var(--orca-border); border-radius: var(--orca-radius, 6px); padding: 14px; }
.empty pre { background: var(--orca-muted); padding: 8px; border-radius: 4px; overflow: auto; }

/* Projects */
.projects { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; border-bottom: 1px solid var(--orca-border); padding-bottom: 8px; }
.project-chip { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 10px; }
.project-chip .muted { font-size: 11px; }
.project-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.project-head .spacer, .actions .spacer, .item-top .spacer { flex: 1; }
.path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head-path { margin-top: -6px; }
button:disabled { opacity: .5; cursor: default; }
.add { display: flex; flex-direction: column; gap: 8px; }
.add p { margin: 0; }
.project-list { display: flex; flex-direction: column; gap: 6px; }
.project-item { display: flex; align-items: center; gap: 8px; border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 6px); padding: 6px 8px; background: var(--orca-card); }
.project-item .grow { flex: 1; min-width: 0; }
.warn-text { color: var(--m-fixing); font-size: 11px; }
.focus-note { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; margin-top: -4px; }
.idle-rows summary { cursor: pointer; font-size: 11px; }
.fix-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.fix-row label { min-width: 150px; }
.inline { display: inline-flex; align-items: center; gap: 4px; }
.idle-rows ul { margin: 4px 0 0 16px; padding: 0; font-size: 11px; }

/* Settings */
.settings { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 6px); padding: 8px 10px; background: var(--orca-card); }
.settings section { display: flex; flex-direction: column; gap: 6px; }
.settings section + section { border-top: 1px solid var(--orca-border); padding-top: 8px; }
.settings h4 { margin: 0; font-size: 12px; }
.settings p { margin: 0; }
.hint { font-size: 11px; }
input[type=text], input[type=number], select { font: inherit; color: inherit; background: var(--orca-background); border: 1px solid var(--orca-input, var(--orca-border));
  border-radius: var(--orca-radius, 6px); padding: 3px 6px; min-width: 0; }
select:disabled { opacity: .5; }
.role { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(130px, 1.4fr) minmax(100px, 1fr); gap: 4px; }
.role > :only-child { grid-column: 1 / -1; }
.item { display: flex; flex-direction: column; gap: 4px; border-left: 2px solid var(--orca-border); padding-left: 8px; }
.item-top { display: flex; align-items: center; gap: 8px; }
.name-input { width: 140px; }
.num { width: 70px; }
.field { display: flex; flex-direction: column; gap: 2px; }
.field-label { font-size: 11px; color: var(--orca-muted-foreground); }
.check { display: inline-flex; align-items: center; gap: 5px; }
.actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.saved { color: var(--m-ready); font-size: 11px; }
.picker-button { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; text-align: left;
  background: var(--orca-background); border-color: var(--orca-input, var(--orca-border)); }
.picker-button.open { border-color: var(--orca-ring); }
.picker-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.picker-none { align-self: center; }
.picker-panel { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--orca-ring);
  border-radius: var(--orca-radius, 6px); padding: 6px; background: var(--orca-card); }
.picker-search { width: 100%; }
.picker-list { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; }
.picker-row { display: flex; flex-direction: column; padding: 3px 6px; border-radius: 4px; cursor: pointer; min-width: 0; }
.picker-row:hover, .picker-row.active { background: var(--orca-accent); }
.picker-row.chosen .picker-main::after { content: ' ✓'; color: var(--m-ready); }
.picker-row.custom .picker-main { color: var(--m-blue); }
.picker-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-sub { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-group { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--orca-muted-foreground); padding: 6px 6px 2px; }
.picker-note { font-size: 11px; padding: 4px 6px; }

/* Timeline */
.strip-label, .axis-label { font-size: 10px; fill: var(--orca-muted-foreground); }
.repo-row { font-weight: 600; padding: 8px 0 2px; border-bottom: 1px solid var(--orca-border); }
.row { display: flex; align-items: center; height: 26px; border-bottom: 1px solid color-mix(in srgb, var(--orca-border) 50%, transparent); }
.row:hover { background: color-mix(in srgb, var(--orca-accent) 50%, transparent); }
.row .label { flex: none; width: clamp(110px, 30%, 260px); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-right: 8px; cursor: pointer; }
.row .label b { font-weight: 600; }
.row svg.chart { flex: 1 1 auto; min-width: 0; width: 100%; display: block; overflow: visible; }
.now-line { stroke: var(--orca-foreground); stroke-width: 1; stroke-dasharray: 2 2; opacity: .5; }
.grid-line { stroke: var(--orca-border); stroke-width: 1; }
.mark { stroke: var(--orca-background); stroke-width: 1; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; }

/* Board */
.columns { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); align-items: start; }
.column { background: color-mix(in srgb, var(--orca-muted) 60%, transparent); border-radius: var(--orca-radius, 6px); padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.column h3 { margin: 2px 2px 0; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.card { background: var(--orca-card); color: var(--orca-card-foreground); border: 1px solid var(--orca-border); border-left: 3px solid var(--lane);
  border-radius: var(--orca-radius, 6px); padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; }
.card .top { display: flex; gap: 6px; align-items: baseline; }
.card .top .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .reason { color: var(--orca-muted-foreground); }
.card .next { font-size: 11px; border-top: 1px dashed var(--orca-border); padding-top: 3px; }
.card .next li { margin-left: 14px; }
.card ul { margin: 0; padding: 0; }
.findings summary { cursor: pointer; font-weight: 500; }
.findings li { list-style: none; margin: 4px 0; padding-left: 0; }
.sev { font-size: 10px; text-transform: uppercase; letter-spacing: .03em; padding: 0 5px; border-radius: 3px; border: 1px solid var(--orca-border); }
.sev-blocker, .sev-major { color: var(--m-blocked); border-color: var(--m-blocked); }
.sev-minor { color: var(--m-fixing); border-color: var(--m-fixing); }
.sev-nit { color: var(--orca-muted-foreground); }
`
