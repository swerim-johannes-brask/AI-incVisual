export interface TreeNode {
  name: string;
  path: string;
  count: number;
  annotatedCount?: number;
  children: TreeNode[];
  images: string[];
}
