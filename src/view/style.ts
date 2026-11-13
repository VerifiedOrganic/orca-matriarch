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
  color-scheme: dark;
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
.project-head .spacer { flex: 1; }
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
.idle-rows ul { margin: 4px 0 0 16px; padding: 0; font-size: 11px; }

/* Controls */
input[type=text], input[type=number], select { font: inherit; color: inherit; background: var(--orca-background); border: 1px solid var(--orca-input, var(--orca-border));
  border-radius: var(--orca-radius, 6px); padding: 3px 6px; min-width: 0; }
select:disabled { opacity: .5; }
.check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.check input { margin: 0; accent-color: var(--m-blue); }
/* A checkbox drawn as a switch. */
input.switch { appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 28px; height: 16px; margin: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--orca-muted-foreground) 40%, transparent); cursor: pointer; transition: background .15s; }
input.switch::before { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .25); transition: transform .15s; }
input.switch:checked { background: var(--m-blue); }
input.switch:checked::before { transform: translateX(12px); }
input.switch:focus-visible { outline: 2px solid color-mix(in srgb, var(--m-blue) 50%, transparent); outline-offset: 2px; }

/* Settings: who does the work as cards, then the rules in groups. */
.settings { container: settings / inline-size; --line: color-mix(in srgb, var(--orca-border) 75%, transparent);
  --panel: color-mix(in srgb, var(--orca-muted, var(--orca-secondary)) 50%, var(--orca-background));
  display: flex; flex-direction: column; gap: 8px; max-width: 920px; padding: 10px 8px 0; background: var(--panel);
  border: 1px solid var(--orca-border); border-radius: calc(var(--orca-radius, 6px) + 2px); }
.settings p { margin: 0; }
.settings [hidden] { display: none; }
.settings-heading { margin: 4px 2px -2px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--orca-muted-foreground); }
.settings-heading:first-of-type { margin-top: 0; }
.settings :is(input[type=text], input[type=number], select, .picker-button) { height: 26px; }
.settings :is(input[type=text], input[type=number]) { padding: 0 8px; }
.settings .picker-button { padding: 0 6px 0 7px; }
.settings select { appearance: none; -webkit-appearance: none; padding-left: 6px; padding-right: 19px; text-overflow: ellipsis; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--orca-muted-foreground) 50%), linear-gradient(135deg, var(--orca-muted-foreground) 50%, transparent 50%);
  background-position: calc(100% - 9px) 55%, calc(100% - 5px) 55%; background-size: 4px 4px; background-repeat: no-repeat; }
.settings :is(input[type=text], input[type=number], select, .picker-button):focus-visible,
.settings :is(input[type=text], input[type=number]):focus { outline: none; border-color: var(--m-blue); box-shadow: 0 0 0 2px color-mix(in srgb, var(--m-blue) 25%, transparent); }
.settings input.num { width: 58px; padding: 0 4px 0 8px; text-align: right; }
.settings .callout b { display: block; }
.set-hint { font-size: 11px; color: var(--orca-muted-foreground); }
.unit { color: var(--orca-muted-foreground); white-space: nowrap; }

/* A role: agent, model and effort on one line. The agent and effort keep room for "Claude Code"
   and "medium effort"; the model takes the rest. */
.role { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 1.5fr) minmax(104px, 1fr);
  grid-template-areas: "agent model effort"; gap: 4px; }
.role > .agent { grid-area: agent; }
.role > .picker-button, .role > .picker-none { grid-area: model; }
.role > .effort { grid-area: effort; }
.picker-button { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; text-align: left;
  background: var(--orca-background); border-color: var(--orca-input, var(--orca-border)); }
.picker-button:hover { background: var(--orca-background); border-color: var(--orca-ring); }
.picker-button.open { border-color: var(--m-blue); }
.picker-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.picker-none { align-self: center; font-size: 11px; padding: 0 2px; }
/* Too narrow for one line: the agent and effort, then the model under them. */
@container role (max-width: 320px) {
  .role { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "agent effort" "model model"; }
}

.roles, .groups { display: flex; flex-direction: column; gap: 8px; }
.rcard, .group { background: var(--orca-card); color: var(--orca-card-foreground); border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 6px); }
.rcard { container: role / inline-size; display: flex; flex-direction: column; gap: 8px; padding: 10px; min-width: 0; }
.rcard-head { display: flex; align-items: center; gap: 6px; min-height: 18px; }
.rcard h4, .group-title { margin: 0; font-size: 12.5px; font-weight: 600; }
.rcard > .set-hint { margin-top: -6px; }
.count { font-size: 11px; color: var(--orca-muted-foreground); background: var(--orca-muted, var(--orca-secondary)); border-radius: 999px; padding: 0 6px; }
.pill-off { color: var(--m-fixing); border-color: var(--m-fixing); background: transparent; }
.item { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line); min-width: 0; }
.item-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.item-head .check { font-size: 11.5px; white-space: nowrap; }
.item-kind { font-size: 11px; color: var(--orca-muted-foreground); }
.settings input.name-input { flex: 1 1 auto; width: 0; min-width: 60px; margin-left: -6px; padding: 0 6px; font-weight: 600;
  background: transparent; border-color: transparent; }
.item-kind + input.name-input { margin-left: -2px; }
.settings input.name-input:hover { border-color: var(--orca-input, var(--orca-border)); }
.settings input.name-input:focus { background: var(--orca-background); }
.settings input.focus-input { width: 100%; }
.item-note { display: flex; flex-direction: column; gap: 1px; font-size: 11px; color: var(--orca-muted-foreground); }
button.remove { flex: none; padding: 2px 6px; font-size: 11px; color: var(--orca-muted-foreground); }
button.remove:hover { color: var(--m-red); background: color-mix(in srgb, var(--m-red) 10%, transparent); }
button.add-row { width: 100%; padding: 4px 8px; color: var(--orca-muted-foreground); background: transparent; border: 1px dashed var(--orca-border); }
button.add-row:hover { color: var(--m-blue); border-color: var(--m-blue); background: color-mix(in srgb, var(--m-blue) 6%, transparent); }
.item.fallback { gap: 4px; }
.item.fallback > .set { padding: 0; }
.crew { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px 20px; }
@container settings (min-width: 700px) {
  .roles { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
  .roles > .wide { grid-column: 1 / -1; }
  .crew { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .item.fallback > .role { width: calc(50% - 10px); }
}

/* The rule groups: closed, a title and a line with the current values. */
.group > summary { list-style: none; position: relative; display: flex; flex-direction: column; gap: 1px; padding: 8px 10px 8px 26px;
  cursor: pointer; border-radius: var(--orca-radius, 6px); }
.group > summary::-webkit-details-marker { display: none; }
.group > summary::before { content: ''; position: absolute; left: 11px; top: 13px; width: 5px; height: 5px;
  border-right: 1.5px solid var(--orca-muted-foreground); border-bottom: 1.5px solid var(--orca-muted-foreground); transform: rotate(-45deg); transition: transform .15s; }
.group[open] > summary::before { transform: rotate(45deg); top: 11px; }
.group > summary:hover { background: color-mix(in srgb, var(--orca-accent) 45%, transparent); }
.group > summary:focus-visible { outline: 2px solid color-mix(in srgb, var(--m-blue) 50%, transparent); outline-offset: -2px; }
.group[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.group-sum { font-size: 11px; color: var(--orca-muted-foreground); }
.group[open] .group-sum { display: none; }
.group-body { padding: 0 10px 2px; border-top: 1px solid var(--line); }
.group-intro { padding: 8px 0 2px; }
.group-sub { margin: 10px 0 0; padding-top: 10px; border-top: 1px solid var(--line); font-size: 10.5px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; color: var(--orca-muted-foreground); }

/* A setting: name and hint on the left, the control on the right. */
.set { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 8px 0; }
.set + .set, .set + .dep > .set:first-child, .dep + .set { border-top: 1px solid var(--line); }
.set-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.set-label { font-weight: 500; cursor: default; }
.set-text label.set-label { cursor: pointer; }
.set-control { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.set-control select { max-width: 100%; }
.set.stack { grid-template-columns: minmax(0, 1fr); }
.set.stack .set-control > * { flex: 1; width: 100%; }
@container settings (min-width: 560px) {
  .set.stack { grid-template-columns: minmax(0, 1fr) minmax(200px, 300px); }
  .set .set-control > select { min-width: 200px; }
}
/* What depends on a switch that is off is dimmed; it keeps its value. */
.set:has(input.switch:not(:checked)) + .dep { opacity: .5; }
.set.fix:has(input.switch:not(:checked)) :is(.num, .unit) { opacity: .45; }

/* Quiet, at the end: turning Matriarch off for this project. */
.danger-zone { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin-top: 4px; padding: 10px;
  border: 1px dashed var(--orca-border); border-radius: var(--orca-radius, 6px); }
.danger-zone .set-text { flex: 1 1 200px; }
.danger-zone .set-control { flex: none; }
button.quiet-danger { background: transparent; color: var(--m-red); border-color: color-mix(in srgb, var(--m-red) 40%, transparent); }
button.quiet-danger:hover { background: color-mix(in srgb, var(--m-red) 10%, transparent); }

.settings-foot { display: flex; align-items: center; gap: 6px; margin: 2px -8px 0; padding: 8px;
  border-top: 1px solid var(--orca-border); }
.settings-foot button { padding: 4px 12px; }
.settings-foot button.primary { font-weight: 600; min-width: 64px; }
.foot-status { flex: 1; min-width: 0; font-size: 11px; color: var(--orca-muted-foreground); }
.foot-status.ok { color: var(--m-ready); }
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
/* An empty lane stays in place, quieter, so the pipeline reads the same whatever is in it. */
.column.empty { opacity: 0.55; }
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
