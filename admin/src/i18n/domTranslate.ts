// admin-web/src/i18n/domTranslate.ts
// Translates the console's visible English text using a dictionary, as the page changes.
// It only swaps text it recognises exactly (or by a listed phrase pattern), so names, numbers and
// anything unknown are left alone. Returns a function that stops it.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT', 'SVG', 'PATH']);
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export const startDomTranslator = (
  words: Record<string, string>,
  phrases: Array<[RegExp, string | ((...m: string[]) => string)]> = [],
): (() => void) => {
  const lookup = (raw: string): string | null => {
    const core = norm(raw);
    if (!core || !/[A-Za-z]/.test(core)) return null;
    if (words[core] !== undefined) return words[core];
    // "Label:" and "Loading…" variants of a known word
    const m = core.match(/^(.*?)(\s*[:…]|\.\.\.)$/);
    if (m && words[m[1]] !== undefined) return words[m[1]] + (m[2].trim() === ':' ? ' :' : m[2].replace('...', '…'));
    for (const [re, to] of phrases) {
      if (re.test(core)) return core.replace(re, to as never);
    }
    return null;
  };

  const fixText = (node: Text) => {
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName.toUpperCase()) || parent.closest('[translate="no"], .notranslate')) return;
    const raw = node.nodeValue ?? '';
    const out = lookup(raw);
    if (out === null) return;
    const lead = raw.match(/^\s*/)?.[0] ?? '';
    const tail = raw.match(/\s*$/)?.[0] ?? '';
    const next = lead + out + tail;
    if (next !== raw) node.nodeValue = next;
  };

  const fixAttrs = (el: Element) => {
    if (el.closest('[translate="no"], .notranslate')) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const out = lookup(v);
      if (out !== null && out !== v) el.setAttribute(a, out);
    }
  };

  const walk = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) { fixText(root as Text); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const el = root as Element;
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
    fixAttrs(el);
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n: Node | null = tw.nextNode();
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
      else fixAttrs(n as Element);
      n = tw.nextNode();
    }
  };

  // Batch work to one pass per frame so rapid re-renders stay cheap.
  const queue = new Set<Node>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const items = [...queue]; queue.clear();
    items.forEach(walk);
  };
  const schedule = (n: Node) => {
    queue.add(n);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(schedule);
      else if (m.type === 'characterData') schedule(m.target);
      else if (m.type === 'attributes') schedule(m.target);
    }
  });

  const begin = () => {
    walk(document.body);
    obs.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: [...ATTRS],
    });
  };
  if (document.body) begin(); else document.addEventListener('DOMContentLoaded', begin, { once: true });

  return () => { obs.disconnect(); queue.clear(); };
};
