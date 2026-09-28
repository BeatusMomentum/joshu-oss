/** Minimal TwiML builder — the gate emits a handful of fixed shapes. */

/** Element text: only &, <, > need escaping. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute values (always double-quoted). */
export function escapeXml(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type TwimlNode = {
  verb: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  children?: TwimlNode[];
  text?: string;
};

function render(node: TwimlNode): string {
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join("");
  const inner =
    (node.text !== undefined ? escapeXmlText(node.text) : "") + (node.children ?? []).map(render).join("");
  return inner ? `<${node.verb}${attrs}>${inner}</${node.verb}>` : `<${node.verb}${attrs}/>`;
}

export function twimlResponse(...nodes: TwimlNode[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${nodes.map(render).join("")}</Response>`;
}
