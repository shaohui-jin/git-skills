# 可视化引擎选型：G6 vs X6

## 结论（当前）

**采用 AntV G6** 作为分支图 / 提交 DAG 可视化引擎。

| | G6 | X6 |
|--|----|----|
| 定位 | 图可视化 / 关系分析 | 图编辑（流程图、DAG 设计器） |
| 布局 | 丰富（dagre、force、radial…） | 偏手工摆放 + 少量布局 |
| 交互 | 缩放、拖拽画布、点选、高亮路径 | 连线、锚点、对齐线、撤销重做 |
| 适合本项目 | 分支溯源、冲突节点高亮、大图浏览 | 若做成「拖节点连线完成 merge」类编辑器 |

## 本项目阶段匹配

- **现在**：展示 commit/tip、merge-base 溯源、缩放平移 → **G6**
- **后续扩展（G6 足够）**：节点点击看详情、冲突文件高亮、路径高亮、minimap、按作者着色
- **再往后若要「画布上拖拽操作 Git」**：可加一层 X6 操作画布，或仅在「编辑模式」切换；**数据层仍用 `@git-insight/core` JSON**

## 代码约定

- UI：`packages/extension/webview` 使用 `@antv/g6`
- 数据适配：`src/graph/toG6Data.ts`（`BranchGraph` → G6 data）
- 能力仍来自 `@git-insight/core`，图库只负责渲染与交互
