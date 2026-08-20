/**
 * git 空 tree 对象（`git hash-object -t tree /dev/null` 的固定值）。
 * 无共同祖先时当作 base 用，让三方 diff / blame 退化为「整侧都是新增」。
 * 必须是合法的 40 位 SHA-1，否则 git 会静默失败（多数调用点带 allowFail）。
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
