export type WebviewRequest =
  | { type: "ready" }
  | { type: "refreshWorkspace" }
  | { type: "setCwd"; path: string }
  | { type: "pickFolder" }
  | { type: "fetch"; remote?: string }
  | {
      type: "graph";
      into?: string;
      from?: string;
      noFetch?: boolean;
      maxNodes?: number;
    }
  | { type: "preview"; into: string; from: string; noFetch?: boolean }
  | { type: "blame"; into: string; from: string; noFetch?: boolean };

export interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare const __GIT_INSIGHT_PREVIEW__: boolean | undefined;

let api: VsCodeApi | undefined;

function dispatchHostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
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

export function getVsCodeApi(): VsCodeApi {
  if (api) {
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
