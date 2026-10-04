// JSONPath / XPath / JSON Pointer support for Arazzo criteria, Selector
// Objects (1.1) and payload replacements. XPath libraries are imported lazily
// so documents that never use XML don't pay for them at startup.
import { jsonpath as jsonpathRfc9535 } from 'json-p3';
import { JSONPath as jsonpathGoessner } from 'jsonpath-plus';
import { applyPointer } from '../runtime-expression.js';
import { setByJsonPointer } from '../openapi/document.js';

export const JSONPATH_VERSIONS = ['rfc9535', 'draft-goessner-dispatch-jsonpath-00'];
export const XPATH_VERSIONS = ['xpath-31', 'xpath-30', 'xpath-20', 'xpath-10'];

function toJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('context is not JSON');
  }
}

/** Values of the nodes a JSONPath query selects. */
export function queryJsonPath(data: unknown, query: string, version?: string): unknown[] {
  const json = toJson(data);
  if (!version || version === 'rfc9535') {
    return jsonpathRfc9535.query(query, json as any).values();
  }
  if (version === 'draft-goessner-dispatch-jsonpath-00') {
    return jsonpathGoessner({ path: query, json: json as any, wrap: true }) as unknown[];
  }
  throw new Error(`unsupported JSONPath version '${version}'`);
}

/** Locations (as key paths) of the nodes a JSONPath query selects, for replacements. */
function jsonPathLocations(data: unknown, query: string, version?: string): (string | number)[][] {
  if (!version || version === 'rfc9535') {
    return jsonpathRfc9535.query(query, data as any).nodes.map((node: any) => node.location as (string | number)[]);
  }
  if (version === 'draft-goessner-dispatch-jsonpath-00') {
    const paths = jsonpathGoessner({ path: query, json: data as any, resultType: 'path', wrap: true }) as string[];
    return paths.map((p) => (jsonpathGoessner as any).toPathArray(p).slice(1));
  }
  throw new Error(`unsupported JSONPath version '${version}'`);
}

let xmlLibs: Promise<{ DOMParser: any; XMLSerializer: any; fontoxpath: any; xpath: any }> | undefined;

function loadXmlLibs() {
  xmlLibs ??= Promise.all([import('@xmldom/xmldom'), import('fontoxpath'), import('xpath')]).then(([xmldom, fx, xp]) => ({
    DOMParser: xmldom.DOMParser,
    XMLSerializer: xmldom.XMLSerializer,
    fontoxpath: (fx as any).default ?? fx,
    xpath: (xp as any).default ?? xp,
  }));
  return xmlLibs;
}

async function parseXml(text: unknown): Promise<any> {
  if (text && typeof text === 'object' && (text as any).nodeType) return text;
  if (typeof text !== 'string') throw new Error('context is not an XML string');
  const { DOMParser } = await loadXmlLibs();
  const parser = new DOMParser({
    onError: (level: string, message: string) => {
      if (level !== 'warning') throw new Error(`invalid XML: ${message}`);
    },
  });
  const doc = parser.parseFromString(text, 'text/xml');
  if (!doc?.documentElement) throw new Error('invalid XML: no document element');
  return doc;
}

function checkXPathVersion(version?: string): void {
  if (version && !XPATH_VERSIONS.includes(version)) throw new Error(`unsupported XPath version '${version}'`);
}

/** Effective boolean value of an XPath expression (XPath 1.0 rules for `xpath-10`, otherwise XPath 3.1 via fontoxpath). */
export async function xpathTruthy(xml: unknown, expression: string, version?: string): Promise<boolean> {
  checkXPathVersion(version);
  const doc = await parseXml(xml);
  const { fontoxpath, xpath } = await loadXmlLibs();
  if (version === 'xpath-10') {
    const result = xpath.select(expression, doc);
    if (typeof result === 'boolean') return result;
    if (typeof result === 'number') return result !== 0 && !Number.isNaN(result);
    if (typeof result === 'string') return result.length > 0;
    return Array.isArray(result) ? result.length > 0 : Boolean(result);
  }
  return fontoxpath.evaluateXPathToBoolean(expression, doc);
}

/** Selects a value: a single match is returned as-is, several matches as an array. */
export async function selectValue(context: unknown, selector: string, type: string, version?: string): Promise<unknown> {
  if (type === 'jsonpointer') {
    return applyPointer(context, selector.startsWith('#') ? selector.slice(1) : selector);
  }
  if (type === 'jsonpath') {
    const values = queryJsonPath(context, selector, version);
    return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
  }
  if (type === 'xpath') {
    checkXPathVersion(version);
    const doc = await parseXml(context);
    const { fontoxpath, xpath } = await loadXmlLibs();
    if (version === 'xpath-10') {
      const result = xpath.select(selector, doc);
      if (!Array.isArray(result)) return result;
      const strings = result.map((node: any) => node.textContent ?? node.nodeValue);
      return strings.length === 0 ? undefined : strings.length === 1 ? strings[0] : strings;
    }
    const strings: string[] = fontoxpath.evaluateXPathToStrings(selector, doc);
    return strings.length === 0 ? undefined : strings.length === 1 ? strings[0] : strings;
  }
  throw new Error(`unsupported selector type '${type}'`);
}

/** Sets `value` at every location a JSONPath selects inside `target` (mutates). Returns the match count. */
export function replaceJsonPath(target: any, query: string, value: unknown, version?: string): number {
  const locations = jsonPathLocations(target, query, version);
  for (const location of locations) {
    if (location.length === 0) continue;
    let current = target;
    for (let i = 0; i < location.length - 1; i += 1) current = current[location[i]];
    current[location[location.length - 1]] = value;
  }
  return locations.length;
}

export function replaceJsonPointer(target: any, pointer: string, value: unknown): void {
  setByJsonPointer(target, pointer.startsWith('#') ? pointer.slice(1) : pointer, value);
}

/** Sets the text (or attribute value) of every node an XPath selects in an XML string; returns the new XML. */
export async function replaceXPath(xml: string, expression: string, value: unknown, version?: string): Promise<{ xml: string; count: number }> {
  checkXPathVersion(version);
  const doc = await parseXml(xml);
  const { fontoxpath, xpath, XMLSerializer } = await loadXmlLibs();
  const nodes: any[] = version === 'xpath-10' ? (xpath.select(expression, doc) as any[]) : fontoxpath.evaluateXPathToNodes(expression, doc);
  const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.nodeType === 2) node.value = text;
    else node.textContent = text;
  }
  const serialized = new XMLSerializer().serializeToString(doc);
  return { xml: serialized, count: Array.isArray(nodes) ? nodes.length : 0 };
}

export function isXmlMediaType(contentType: string | undefined): boolean {
  return Boolean(contentType && /[/+]xml\b/i.test(contentType));
}

export function isJsonMediaType(contentType: string | undefined): boolean {
  return Boolean(contentType && /[/+]json\b/i.test(contentType));
}
