import type {
  AiResolveHunkInput,
  AiResolveHunkResult,
  AiResolveRequestPayload,
  AiResolveResponsePayload,
  AiResolveRuleId,
} from "./aiResolveTypes.js";

const RULE_TEXT: Record<AiResolveRuleId, string> = {
  preferMine:
    "默认偏我的：冲突块优先采「我的分支」(theirs/右栏)；仅当我的为空/误删、或路径像锁文件/生成物时采线上(ours/左栏)。",
  preferOnline:
    "默认偏线上：冲突块优先采「线上」(ours/左栏)；功能逻辑改动再采我的(theirs/右栏)。",
  newerWins:
    "新覆盖旧：比较两侧 oursCommits/theirsCommits 中最新的 time（Unix 秒），较新一侧整块胜出；缺时间则跳过本条并在 reason 说明。",
  mergeWhenPossible:
    "可合并则合并：两边改动可兼容时 choice=merge 并给出 mergedContent；无法判断则按其它规则选边。未勾选本规则时禁止返回 merge。",
};

export function buildAiSystemPrompt(rules: AiResolveRuleId[], allowMerge: boolean): string {
  const ruleLines = rules.map((r) => `- ${RULE_TEXT[r]}`).join("\n");
  return [
    "你是 Git 合并冲突裁决助手。业务角色固定：",
    "- ours / 左栏 = 线上目标分支（into）",
    "- theirs / 右栏 = 我的分支（from）",
    "不要按口语「我的=ours」理解，必须按上面角色。",
    "",
    "用户勾选的规章制度：",
    ruleLines || "- （无）",
    "",
    "裁决优先级（必须遵守）：",
    "1) 用户「额外说明」中的明确路径/字段指令",
    "2) newerWins（若勾选且两侧都有可用 time）",
    "3) mergeWhenPossible（若勾选且可合并）",
    "4) preferMine 或 preferOnline（若勾选）",
    "5) 仍无法判断 → choice=pending，reason 说明需人工",
    "",
    allowMerge
      ? "允许 choice=merge，并提供完整 mergedContent（仅该冲突块的结果文本，不要冲突标记）。"
      : "禁止 choice=merge；只能 ours / theirs / pending。",
    "",
    "只输出一个 JSON 对象，不要 markdown 围栏，不要其它说明。格式：",
    '{"hunks":[{"id":"...","path":"...","choice":"ours|theirs|merge|pending","mergedContent":"可选","reason":"简短中文"}]}',
    "必须覆盖输入中的每一个 hunk；id 与 path 必须原样返回（id 形如 path::h-N，跨文件唯一）。",
  ].join("\n");
}

/** 跨文件唯一：各文件本地 id 都会从 h-0 起算，必须带 path */
export const AI_HUNK_ID_SEP = "::";

export function toAiHunkId(path: string, localId: string): string {
  return `${path}${AI_HUNK_ID_SEP}${localId}`;
}

export function fromAiHunkId(aiId: string): { path: string | null; localId: string } {
  const idx = aiId.lastIndexOf(AI_HUNK_ID_SEP);
  if (idx <= 0) {
    return { path: null, localId: aiId };
  }
  return {
    path: aiId.slice(0, idx),
    localId: aiId.slice(idx + AI_HUNK_ID_SEP.length),
  };
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…(截断)`;
}

function formatCommits(
  commits: AiResolveHunkInput["oursCommits"],
): Array<{ sha: string; author: string; time?: number; message?: string }> {
  return commits.slice(0, 8).map((c) => ({
    sha: c.sha.slice(0, 12),
    author: c.author,
    time: c.time,
    message: c.message ? truncate(c.message, 120) : undefined,
  }));
}

export function buildAiUserPrompt(req: AiResolveRequestPayload): string {
  const hunks = req.hunks.map((h) => ({
    id: h.id,
    path: h.path,
    left_online: truncate(h.leftText, 4000),
    right_mine: truncate(h.rightText, 4000),
    base: truncate(h.baseText, 2000),
    oursCommits: formatCommits(h.oursCommits),
    theirsCommits: formatCommits(h.theirsCommits),
  }));
  return JSON.stringify(
    {
      into_online: req.into,
      from_mine: req.from,
      rules: req.rules,
      extraNotes: req.extraNotes || "",
      hunks,
    },
    null,
    2,
  );
}

export function extractAiJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      return JSON.parse(fence[1].trim());
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("模型未返回合法 JSON");
  }
}

export function normalizeAiResults(
  raw: unknown,
  input: AiResolveHunkInput[],
  allowMerge: boolean,
): AiResolveHunkResult[] {
  type Src = AiResolveHunkInput & { localId: string; key: string };

  const sources: Src[] = input.map((h) => {
    const decoded = fromAiHunkId(h.id);
    const localId =
      decoded.path != null &&
      (normPath(decoded.path) === normPath(h.path) || h.id.includes(AI_HUNK_ID_SEP))
        ? decoded.localId
        : h.id;
    return {
      ...h,
      localId,
      key: `${normPath(h.path)}\0${localId}`,
    };
  });

  const byKey = new Map(sources.map((h) => [h.key, h]));
  const byAiId = new Map(sources.map((h) => [h.id, h]));

  const arr =
    raw && typeof raw === "object" && Array.isArray((raw as { hunks?: unknown }).hunks)
      ? (raw as { hunks: unknown[] }).hunks
      : [];
  const out: AiResolveHunkResult[] = [];
  const seen = new Set<string>();

  function resolveSrc(id: string, pathHintRaw: string): Src | undefined {
    const pathHint = normPath(pathHintRaw);
    if (pathHint) {
      const byPathId = byKey.get(`${pathHint}\0${id}`);
      if (byPathId) {
        return byPathId;
      }
      const decoded = fromAiHunkId(id);
      const byPathLocal = byKey.get(`${pathHint}\0${decoded.localId}`);
      if (byPathLocal) {
        return byPathLocal;
      }
    }
    const byExact = byAiId.get(id);
    if (byExact) {
      return byExact;
    }
    const decoded = fromAiHunkId(id);
    if (decoded.path) {
      const hit = byKey.get(`${normPath(decoded.path)}\0${decoded.localId}`);
      if (hit) {
        return hit;
      }
    }
    const hits = sources.filter((h) => h.localId === id || h.id === id);
    return hits.length === 1 ? hits[0] : undefined;
  }

  for (const item of arr) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? "");
    const src = resolveSrc(id, String(o.path ?? ""));
    if (!src || seen.has(src.key)) {
      continue;
    }
    seen.add(src.key);
    let choice = String(o.choice ?? "pending") as AiResolveHunkResult["choice"];
    if (!["ours", "theirs", "merge", "pending"].includes(choice)) {
      choice = "pending";
    }
    if (choice === "merge" && !allowMerge) {
      choice = "pending";
    }
    const mergedContent =
      choice === "merge" && typeof o.mergedContent === "string" ? o.mergedContent : undefined;
    if (choice === "merge" && (mergedContent == null || mergedContent === "")) {
      choice = "pending";
    }
    out.push({
      id: src.localId,
      path: src.path,
      choice,
      mergedContent,
      reason: typeof o.reason === "string" ? o.reason : undefined,
    });
  }

  for (const h of sources) {
    if (!seen.has(h.key)) {
      out.push({
        id: h.localId,
        path: h.path,
        choice: "pending",
        reason: "模型未返回该冲突块",
      });
    }
  }
  return out;
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function runAiResolveWithOpenAiCompat(
  req: AiResolveRequestPayload,
  api: OpenAiCompatOptions,
  onProgress?: (label: string, percent: number) => void | Promise<void>,
): Promise<AiResolveResponsePayload> {
  if (!req.hunks.length) {
    throw new Error("没有待解决的冲突块");
  }
  const base = api.baseUrl.replace(/\/+$/, "");
  const model = api.model.trim();
  const key = api.apiKey.trim();
  if (!base || !model) {
    throw new Error("请先在「Git 配置」填写 AI Base URL 与模型名");
  }
  // Ollama 等本地服务可无 key
  const allowMerge = req.rules.includes("mergeWhenPossible");
  await onProgress?.(`调用 OpenAI 兼容接口 ${model}…`, 25);

  const body = {
    model,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: buildAiSystemPrompt(req.rules, allowMerge),
      },
      {
        role: "user",
        content: buildAiUserPrompt(req),
      },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    await onProgress?.("等待模型响应…", 50);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API HTTP ${res.status}：${text.slice(0, 500)}`);
    }
    let content = "";
    try {
      const json = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      content = json.choices?.[0]?.message?.content ?? "";
    } catch {
      throw new Error(`API 返回非 JSON：${text.slice(0, 300)}`);
    }
    if (!content.trim()) {
      throw new Error("API 返回空内容");
    }
    await onProgress?.("解析结果…", 85);
    const parsed = extractAiJson(content);
    const hunks = normalizeAiResults(parsed, req.hunks, allowMerge);
    return {
      hunks,
      model,
      messages: [`OpenAI 兼容：${model}`],
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("AI 选边超时（120s）");
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}
