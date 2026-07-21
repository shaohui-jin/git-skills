import {
  DEMO_GRAPH,
  DEMO_GRAPH_REPORT,
  DEMO_PREVIEW,
  DEMO_PREVIEW_REPORT,
  demoWorkspaceMessage,
} from "./demoFixtures";

export type WebviewRequest =
  | { type: "ready" }
  | { type: "refreshWorkspace" }
  | { type: "setCwd"; path: string }
  | { type: "pickFolder" }
  | { type: "fetch"; remote?: string }
  | { type: "graph"; into?: string; from?: string; noFetch?: boolean }
  | { type: "preview"; into: string; from: string; noFetch?: boolean }
  | { type: "blame"; into: string; from: string; noFetch?: boolean };

export interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare const __GIT_INSIGHT_PREVIEW__: boolean | undefined;
declare const __GIT_INSIGHT_DEMO__: boolean | undefined;

let api: VsCodeApi | undefined;

function dispatchHostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function createDemoBridge(): VsCodeApi {
  const reply = (payload: unknown) => {
    // 下一帧派发，模拟异步宿主
    queueMicrotask(() => dispatchHostMessage(payload));
  };

  return {
    postMessage(message) {
      if (message.type === "ready" || message.type === "refreshWorkspace") {
        reply(demoWorkspaceMessage());
        reply({ type: "busy", busy: true, label: "加载演示分支图…" });
        reply({
          type: "graphResult",
          data: DEMO_GRAPH,
          report: DEMO_GRAPH_REPORT,
          mermaid: "",
        });
        reply({ type: "busy", busy: false });
        return;
      }
      if (message.type === "setCwd" || message.type === "pickFolder") {
        reply({
          type: "error",
          message:
            "离线样例无法打开本机仓库。请本地运行 pnpm preview。",
            code: "DEMO_READONLY",
        });
        reply(demoWorkspaceMessage());
        return;
      }
      if (message.type === "fetch") {
        reply({
          type: "fetchResult",
          data: {
            repoRoot: "(演示仓库)",
            remote: "origin",
            ok: true,
            stdout: "(demo) skipped",
            stderr: "",
          },
          report: "演示模式：未执行真实 fetch。",
        });
        return;
      }
      if (message.type === "graph") {
        reply({ type: "busy", busy: true, label: "加载演示分支图…" });
        reply({
          type: "graphResult",
          data: DEMO_GRAPH,
          report: DEMO_GRAPH_REPORT,
          mermaid: "",
        });
        reply({ type: "busy", busy: false });
        return;
      }
      if (message.type === "preview" || message.type === "blame") {
        reply({ type: "busy", busy: true, label: "合并预演（演示）…" });
        const data = {
          ...DEMO_PREVIEW,
          into: message.into || DEMO_PREVIEW.into,
          from: message.from || DEMO_PREVIEW.from,
        };
        reply({
          type: "previewResult",
          data,
          report: DEMO_PREVIEW_REPORT,
          mermaid: "",
        });
        reply({ type: "busy", busy: false });
      }
    },
    getState: () => undefined,
    setState: () => undefined,
  };
}

function createBrowserBridge(): VsCodeApi {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${location.host}/ws`;
  let socket: WebSocket | null = null;
  let opened = false;
  const queue: WebviewRequest[] = [];

  const connect = () => {
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
      opened = true;
      while (queue.length > 0) {
        const msg = queue.shift();
        if (msg) {
          socket?.send(JSON.stringify(msg));
        }
      }
    });
    socket.addEventListener("message", (ev) => {
      try {
        dispatchHostMessage(JSON.parse(String(ev.data)));
      } catch {
        dispatchHostMessage({
          type: "error",
          message: "无法解析预览服务响应",
        });
      }
    });
    socket.addEventListener("close", () => {
      opened = false;
      dispatchHostMessage({
        type: "error",
        message: "与本地预览服务断开，请确认 pnpm preview 仍在运行",
      });
      setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => {
      // close handler reconnects
    });
  };

  connect();

  return {
    postMessage(message) {
      if (opened && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      } else {
        queue.push(message);
      }
    },
    getState: () => undefined,
    setState: () => undefined,
  };
}

function isDemoBuild(): boolean {
  if (typeof __GIT_INSIGHT_DEMO__ !== "undefined" && __GIT_INSIGHT_DEMO__) {
    return true;
  }
  try {
    return new URLSearchParams(location.search).get("demo") === "1";
  } catch {
    return false;
  }
}

export function getVsCodeApi(): VsCodeApi {
  if (api) {
    return api;
  }

  if (isDemoBuild()) {
    api = createDemoBridge();
    return api;
  }

  const forcePreview =
    typeof __GIT_INSIGHT_PREVIEW__ !== "undefined" && __GIT_INSIGHT_PREVIEW__;

  if (!forcePreview) {
    try {
      api = acquireVsCodeApi();
      return api;
    } catch {
      // browser bridge
    }
  }

  api = createBrowserBridge();
  return api;
}

export function isPreviewMode(): boolean {
  return typeof __GIT_INSIGHT_PREVIEW__ !== "undefined" && !!__GIT_INSIGHT_PREVIEW__;
}

export function isDemoMode(): boolean {
  return isDemoBuild();
}
