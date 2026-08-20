/**
 * 报告正文里含 git 提供的分支名 / 提交作者 / 提交信息，可以是任意字符，
 * 而 marked 会把其中的原始 HTML 原样透传。渲染前按白名单裁剪。
 */

const ALLOWED_TAGS = new Set([
  "A",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "DETAILS",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "STRONG",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** 这些标签连内容一起丢弃；其余不在白名单的标签只脱掉外壳、保留文字 */
const DROP_WITH_CONTENT = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK"]);

const ALLOWED_ATTRS = new Map<string, Set<string>>([["A", new Set(["href", "title"])]]);

function isSafeHref(value: string): boolean {
  try {
    const { protocol } = new URL(value, "https://git-insight.invalid");
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

export function sanitizeReportHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const unwrap: Element[] = [];
  const drop: Element[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    if (DROP_WITH_CONTENT.has(el.tagName)) {
      drop.push(el);
      continue;
    }
    if (!ALLOWED_TAGS.has(el.tagName)) {
      unwrap.push(el);
      continue;
    }
    const allowed = ALLOWED_ATTRS.get(el.tagName);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const keep =
        allowed?.has(name) === true && (name !== "href" || isSafeHref(attr.value));
      if (!keep) {
        el.removeAttribute(attr.name);
      }
    }
  }

  for (const el of drop) {
    el.remove();
  }
  for (const el of unwrap) {
    el.replaceWith(...Array.from(el.childNodes));
  }
  return doc.body.innerHTML;
}
