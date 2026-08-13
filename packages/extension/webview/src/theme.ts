import { computed, ref } from "vue";

/**
 * 面板自带深/浅两套配色，不跟 IDE 的主题色，只跟它的明暗。
 *
 * 扩展宿主把初始值写在 <html data-theme>（首帧就是对的，不会闪一下暗色），
 * 之后靠 host 的 theme 消息热更新。浏览器预览没有宿主，initTheme() 退回系统偏好。
 */
export type ThemeName = "light" | "dark";

function root(): HTMLElement {
  return document.documentElement;
}

function readFromDom(): ThemeName {
  return root().dataset.theme === "light" ? "light" : "dark";
}

/* 模块是 <script type="module">，执行时 <html> 上的 data-theme 已经解析好了 */
const themeRef = ref<ThemeName>(readFromDom());

/** 模板与 computed 用它；canvas 那种命令式的用 onThemeChange */
export const theme = computed(() => themeRef.value);

const listeners = new Set<(theme: ThemeName) => void>();
let mediaBound = false;

export function currentTheme(): ThemeName {
  return themeRef.value;
}

export function applyTheme(next: ThemeName): void {
  root().dataset.theme = next;
  // 值没变就别通知：监听方大多是「整个重建画布」，白跑一次很贵
  if (themeRef.value === next) {
    return;
  }
  themeRef.value = next;
  for (const fn of listeners) {
    fn(next);
  }
}

/** canvas 之类吃不到 CSS 变量的地方，靠它在主题变化后重画 */
export function onThemeChange(fn: (theme: ThemeName) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 宿主没写 data-theme 说明是浏览器预览，此时跟随系统偏好。
 * 宿主写了就不插手——它之后会用 theme 消息推更新。
 */
export function initTheme(): void {
  if (root().dataset.theme) {
    return;
  }
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  applyTheme(mq.matches ? "light" : "dark");
  if (!mediaBound) {
    mediaBound = true;
    mq.addEventListener("change", (ev) => {
      applyTheme(ev.matches ? "light" : "dark");
    });
  }
}

/** 读 CSS 变量的实际色值：canvas 渲染要和 CSS 用同一个色源 */
export function cssVar(name: string, fallback = "#888888"): string {
  const value = getComputedStyle(root()).getPropertyValue(name).trim();
  return value || fallback;
}
