// Tiny DOM helpers shared by the view's modules.
export type Child = Node | string | null | undefined | false
export type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>

export function setAttrs(node: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, '').toLowerCase(), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
}

export function el(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag)
  setAttrs(node, attrs)
  for (const c of children) if (c) node.append(c)
  return node
}

export function sv(tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  setAttrs(node, attrs)
  for (const c of children) if (c) node.append(c)
  return node
}

/** A select whose options are [value, label] pairs. */
export function select(value: string, options: readonly (readonly [string, string])[], onchange: (v: string) => void, attrs: Attrs = {}): HTMLElement {
  const node = el('select', { ...attrs, onchange: (e) => onchange((e.target as HTMLSelectElement).value) },
    ...options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)))
  ;(node as HTMLSelectElement).value = value
  return node
}

export function textInput(value: string, oninput: (v: string) => void, attrs: Attrs = {}): HTMLElement {
  const node = el('input', { type: 'text', ...attrs, oninput: (e) => oninput((e.target as HTMLInputElement).value) })
  ;(node as HTMLInputElement).value = value
  return node
}

export function checkbox(checked: boolean, label: string, onchange: (on: boolean) => void, attrs: Attrs = {}): HTMLElement {
  return el('label', { class: 'check', ...attrs },
    el('input', { type: 'checkbox', checked, onchange: (e) => onchange((e.target as HTMLInputElement).checked) }), label)
}

/** An on/off switch: a checkbox drawn as a switch, labelled by whatever points at its id. */
export function toggle(checked: boolean, onchange: (on: boolean) => void, attrs: Attrs = {}): HTMLElement {
  return el('input', { type: 'checkbox', role: 'switch', class: 'switch', checked, ...attrs, onchange: (e) => onchange((e.target as HTMLInputElement).checked) })
}
