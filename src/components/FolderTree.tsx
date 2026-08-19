import type { TreeNode } from "../types/DatasetTree";

type FilterMode = "all" | "annotated" | "unannotated";

interface FolderTreeProps {
  node: TreeNode;
  selectedFolderPath: string | null;
  selectedImagePath: string | null;
  expandedFolders: Set<string>;
  annotatedSet?: Set<string>;
  filterMode?: FilterMode;
  onFolderSelected: (path: string | null) => void;
  onToggleFolder: (path: string) => void;
  onImageSelected: (path: string) => void;
}

function matchesFilter(isAnnotated: boolean, filterMode: FilterMode = "all") {
  if (filterMode === "all") return true;
  return filterMode === "annotated" ? isAnnotated : !isAnnotated;
}

function treeHasVisibleContent(
  node: TreeNode,
  filterMode: FilterMode,
  annotatedSet?: Set<string>
): boolean {
  if (
    node.images.some((image) => {
      const fullPath = node.path === "" ? image : `${node.path}/${image}`;
      return matchesFilter(Boolean(annotatedSet?.has(fullPath)), filterMode);
    })
  ) {
    return true;
  }

  return node.children.some((child) =>
    treeHasVisibleContent(child, filterMode, annotatedSet)
  );
}

function TreeNodeView({
  node,
  level = 0,
  selectedFolderPath,
  selectedImagePath,
  expandedFolders,
  annotatedSet,
  filterMode = "all",
  onFolderSelected,
  onToggleFolder,
  onImageSelected,
}: {
  node: TreeNode;
  level?: number;
  selectedFolderPath: string | null;
  selectedImagePath: string | null;
  expandedFolders: Set<string>;
  annotatedSet?: Set<string>;
  filterMode?: FilterMode;
  onFolderSelected: (path: string | null) => void;
  onToggleFolder: (path: string) => void;
  onImageSelected: (path: string) => void;
}) {
  if (!treeHasVisibleContent(node, filterMode, annotatedSet)) {
    return null;
  }

  const isRoot = node.path === "";
  const isSelectedFolder = !isRoot && selectedFolderPath === node.path;
  const isExpanded = isRoot || expandedFolders.has(node.path);

  return (
    <div>
      {isRoot ? (
        <div
          onClick={() => onFolderSelected(null)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 36,
            padding: "6px 8px",
            marginBottom: 8,
            borderRadius: 6,
            cursor: "pointer",
            background: selectedFolderPath === null ? "#edf4ff" : "#f8fafc",
            border: selectedFolderPath === null ? "1px solid #d9e7ff" : "1px solid #e5e7eb",
            color: selectedFolderPath === null ? "#0b57d0" : "#1f2937",
            fontWeight: selectedFolderPath === null ? 700 : 600,
            fontSize: 13,
          }}
        >
          <span style={{ fontSize: 13 }}>📁</span>
          <span>All images</span>
          <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12 }}>
            {node.count} / {node.annotatedCount ?? 0}
          </span>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 30,
            padding: "4px 8px",
            margin: "2px 0",
            borderRadius: 6,
            cursor: "pointer",
            background: isSelectedFolder ? "#edf4ff" : "transparent",
            border: isSelectedFolder ? "1px solid #d9e7ff" : "1px solid transparent",
            color: isSelectedFolder ? "#0b57d0" : "#1f2937",
            fontWeight: isSelectedFolder ? 700 : 600,
            fontSize: 13,
          }}
        >
          <button
            type="button"
            onClick={() => onToggleFolder(node.path)}
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            style={{
              width: 20,
              height: 20,
              border: "1px solid #d1d5db",
              borderRadius: 6,
              background: "#ffffff",
              cursor: "pointer",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              color: "#374151",
            }}
          >
            {node.children.length === 0 ? "•" : isExpanded ? "▾" : "▸"}
          </button>

          <div
            onClick={() => onFolderSelected(node.path)}
            style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}
          >
            <span style={{ fontSize: 13 }}>📁</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
            <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12 }}>{node.count} / {node.annotatedCount ?? 0}</span>
          </div>
        </div>
      )}

      {node.children.length > 0 && isExpanded && (
        <div style={{ paddingLeft: `${(level + 1) * 12}px` }}>
          {node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              level={level + 1}
              selectedFolderPath={selectedFolderPath}
              selectedImagePath={selectedImagePath}
              expandedFolders={expandedFolders}
              annotatedSet={annotatedSet}
              filterMode={filterMode}
              onFolderSelected={onFolderSelected}
              onToggleFolder={onToggleFolder}
              onImageSelected={onImageSelected}
            />
          ))}
        </div>
      )}

      {isExpanded &&
        node.images.map((image) => {
          const fullPath = node.path === "" ? image : `${node.path}/${image}`;
          const isSelectedImage = selectedImagePath === fullPath;
          const isAnnotated = Boolean(annotatedSet?.has(fullPath));

          if (!matchesFilter(isAnnotated, filterMode)) {
            return null;
          }

          return (
            <div
              id={`file-${encodeURIComponent(fullPath)}`}
              key={fullPath}
              onClick={() => onImageSelected(fullPath)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minHeight: 26,
                padding: "4px 8px 4px 28px",
                margin: "1px 0",
                borderRadius: 6,
                cursor: "pointer",
                background: isSelectedImage ? "#edf4ff" : "transparent",
                border: isSelectedImage ? "1px solid #d9e7ff" : "1px solid transparent",
                color: isSelectedImage ? "#0b57d0" : "#4b5563",
                fontWeight: isSelectedImage ? 600 : 500,
                fontSize: 12,
              }}
            >
              <span style={{ width: 14, textAlign: "center", color: isAnnotated ? "#0b9538" : "transparent" }}>{isAnnotated ? "●" : ""}</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{image}</span>
            </div>
          );
        })}
    </div>
  );
}

export default function FolderTree({
  node,
  selectedFolderPath,
  selectedImagePath,
  expandedFolders,
  annotatedSet,
  filterMode = "all",
  onFolderSelected,
  onToggleFolder,
  onImageSelected,
}: FolderTreeProps) {
  const rawRoot = node.children.find((child) => child.name.toLowerCase() === "raw");
  const visibleNode = rawRoot ?? node;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rawRoot ? (
        <div
          onClick={() => onFolderSelected("raw")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 36,
            padding: "6px 8px",
            marginBottom: 8,
            borderRadius: 6,
            cursor: "pointer",
            background: selectedFolderPath === "raw" ? "#edf4ff" : "#f8fafc",
            border: selectedFolderPath === "raw" ? "1px solid #d9e7ff" : "1px solid #e5e7eb",
            color: selectedFolderPath === "raw" ? "#0b57d0" : "#1f2937",
            fontWeight: selectedFolderPath === "raw" ? 700 : 600,
            fontSize: 13,
          }}
        >
          <span style={{ fontSize: 13 }}>📁</span>
          <span>raw</span>
          <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12 }}>{rawRoot.count} / {rawRoot.annotatedCount ?? 0}</span>
        </div>
      ) : (
        <TreeNodeView
          node={visibleNode}
          selectedFolderPath={selectedFolderPath}
          selectedImagePath={selectedImagePath}
          expandedFolders={expandedFolders}
          annotatedSet={annotatedSet}
          filterMode={filterMode}
          onFolderSelected={onFolderSelected}
          onToggleFolder={onToggleFolder}
          onImageSelected={onImageSelected}
        />
      )}

      {rawRoot && (
        <div style={{ paddingLeft: 12 }}>
          {rawRoot.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              level={1}
              selectedFolderPath={selectedFolderPath}
              selectedImagePath={selectedImagePath}
              expandedFolders={expandedFolders}
              annotatedSet={annotatedSet}
              filterMode={filterMode}
              onFolderSelected={onFolderSelected}
              onToggleFolder={onToggleFolder}
              onImageSelected={onImageSelected}
            />
          ))}

          {rawRoot.images.map((image) => {
            const fullPath = `${rawRoot.path}/${image}`;
            const isSelectedImage = selectedImagePath === fullPath;
            const isAnnotated = Boolean(annotatedSet?.has(fullPath));

            if (!matchesFilter(isAnnotated, filterMode)) {
              return null;
            }

            return (
              <div
                key={fullPath}
                id={`file-${encodeURIComponent(fullPath)}`}
                onClick={() => onImageSelected(fullPath)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 26,
                  padding: "4px 8px 4px 28px",
                  margin: "1px 0",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isSelectedImage ? "#edf4ff" : "transparent",
                  border: isSelectedImage ? "1px solid #d9e7ff" : "1px solid transparent",
                  color: isSelectedImage ? "#0b57d0" : "#4b5563",
                  fontWeight: isSelectedImage ? 600 : 500,
                  fontSize: 12,
                }}
              >
                <span style={{ width: 14, textAlign: "center", color: isAnnotated ? "#0b9538" : "transparent" }}>{isAnnotated ? "●" : ""}</span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{image}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
