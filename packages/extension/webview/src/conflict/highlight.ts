import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

let registered = false;

function ensureRegistered(): void {
  if (registered) {
    return;
  }
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("vue", xml);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("python", python);
  registered = true;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  html: "html",
  htm: "html",
  vue: "vue",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  java: "java",
  py: "python",
};

/** 超过此字节数跳过语法高亮，仅保留 diff 着色 */
export const HIGHLIGHT_MAX_BYTES = 200_000;

export function languageFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return "plaintext";
  }
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] ?? "plaintext";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 高亮代码；大文件或未知语言时回退为转义纯文本。
 * 返回可安全用于 v-html 的 HTML（无外层 pre）。
 */
export function highlightCode(code: string, path: string): string {
  if (!code) {
    return "";
  }
  if (code.length > HIGHLIGHT_MAX_BYTES) {
    return escapeHtml(code);
  }
  ensureRegistered();
  const lang = languageFromPath(path);
  if (lang === "plaintext" || !hljs.getLanguage(lang)) {
    return escapeHtml(code);
  }
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/** 按行高亮后拆成行 HTML（与行数组对齐） */
export function highlightLines(lines: string[], path: string): string[] {
  if (lines.length === 0) {
    return [];
  }
  const code = lines.join("\n");
  const html = highlightCode(code, path);
  // highlight.js 可能在行内产生 span，按 \n 拆即可
  return html.split("\n");
}
