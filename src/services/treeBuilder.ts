import type { TreeNode } from "../types/DatasetTree";

export function buildTree(
  imagePaths: string[]
): TreeNode {

  const root: TreeNode = {
    name: "root",
    path: "",
    count: 0,
    children: [],
    images: []
  };

  for (const path of imagePaths) {

    const parts = path.split("/");

    let current = root;

    current.count++;

    for (let i = 0; i < parts.length - 1; i++) {

      const folderName = parts[i];

      let child =
        current.children.find(
          c => c.name === folderName
        );

      if (!child) {

        child = {
          name: folderName,
          path: parts
            .slice(0, i + 1)
            .join("/"),
          count: 0,
          children: [],
          images: []
        };

        current.children.push(child);
      }

      child.count++;

      current = child;
    }

    current.images.push(
      parts[parts.length - 1]
    );
  }

  return root;
}