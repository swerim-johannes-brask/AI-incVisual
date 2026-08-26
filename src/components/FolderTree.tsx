import type { NoteValue } from "../services/azureBlobService";
import type { TreeNode } from "../types/DatasetTree";

// ADDED "flagged" to the types here
type FilterMode = "all" | "annotated" | "unannotated" | "notes" | "flagged";

interface FolderTreeProps {
  node: TreeNode;
  selectedFolderPath: string | null;
  selectedImagePath: string | null;
  expandedFolders: Set<string>;
  annotatedSet?: Set<string>;
  noteSet?: Set<string>;
  notes?: Record<string, NoteValue>;
  filterMode?: FilterMode;
  onFolderSelected: (path: string | null) => void;
  onToggleFolder: (path: string) => void;
  onImageSelected: (path: string) => void;
}

// UPDATED normalizer to include flagged
function normalizeNoteValue(value: NoteValue | undefined): {
  question: string;
  reply: string;
  comments: string[];
  answered: boolean;
  flagged: boolean;
} {
  if (typeof value === "string") return { question: value, reply: "", comments: [], answered: false, flagged: false };
  if (!value || typeof value !== "object") return { question: "", reply: "", comments: [], answered: false, flagged: false };
  
  const question = value.question ?? value.note ?? value.comment ?? "";
  const reply = value.reply ?? value.answer ?? "";
  const comments = Array.isArray(value.comments)
    ? value.comments.filter((comment): comment is string => typeof comment === "string" && comment.trim().length > 0).map((comment) => comment.trim())
    : typeof value.comments === "string" && value.comments.trim().length > 0
      ? [value.comments.trim()]
      : [];

  return {
    question,
    reply,
    comments,
    answered: typeof value.answered === "boolean" ? value.answered : Boolean(reply),
    flagged: Boolean(value.flagged),
  };
}

// UPDATED to check the flag status
function matchesFilter(
  isAnnotated: boolean,
  hasNote: boolean,
  isFlagged: boolean,
  filterMode: FilterMode = "all"
) {
  if (filterMode === "all") return true;
  if (filterMode === "notes") return hasNote;
  if (filterMode === "flagged") return isFlagged;
  if (filterMode === "annotated") return isAnnotated;
  return !isAnnotated;
}

// UPDATED to pass flag status down
function treeHasVisibleContent(
  node: TreeNode,
  filterMode: FilterMode,
  annotatedSet?: Set<string>,
  noteSet?: Set<string>,
  notes?: Record<string, NoteValue>
): boolean {
  if (
    node.images.some((image) => {
      const fullPath = node.path === "" ? image : `${node.path}/${image}`;
      const isAnnotated = Boolean(annotatedSet?.has(fullPath));
      const hasNote = Boolean(noteSet?.has(fullPath) || notes?.[fullPath]);
      const noteMeta = normalizeNoteValue(notes?.[fullPath]);
      return matchesFilter(isAnnotated, hasNote, noteMeta.flagged, filterMode);
    })
  ) {
    return true;
  }

  return node.children.some((child) =>
    treeHasVisibleContent(child, filterMode, annotatedSet, noteSet, notes)
  );
}

function getAnnotatedNodeCount(node: TreeNode, annotatedSet?: Set<string>): number {
  const directAnnotated = node.images.reduce((total, image) => {
    const fullPath = node.path === "" ? image : `${node.path}/${image}`;
    return total + (annotatedSet?.has(fullPath) ? 1 : 0);
  }, 0);

  return (
    directAnnotated +
    node.children.reduce(
      (total, child) => total + getAnnotatedNodeCount(child, annotatedSet),
      0
    )
  );
}

function getFolderCountLabel(node: TreeNode, annotatedSet?: Set<string>) {
  if (!annotatedSet) {
    return String(node.count);
  }
  return `${node.count}/${getAnnotatedNodeCount(node, annotatedSet)}`;
}

function TreeNodeView({
  node, level = 0, selectedFolderPath, selectedImagePath, expandedFolders, annotatedSet, noteSet, notes, filterMode = "all", onFolderSelected, onToggleFolder, onImageSelected,
}: {
  node: TreeNode; level?: number; selectedFolderPath: string | null; selectedImagePath: string | null; expandedFolders: Set<string>; annotatedSet?: Set<string>; noteSet?: Set<string>; notes?: Record<string, NoteValue>; filterMode?: FilterMode; onFolderSelected: (path: string | null) => void; onToggleFolder: (path: string) => void; onImageSelected: (path: string) => void;
}) {
  if (!treeHasVisibleContent(node, filterMode, annotatedSet, noteSet, notes)) return null;

  const isRoot = node.path === "";
  const isSelectedFolder = !isRoot && selectedFolderPath === node.path;
  const isExpanded = isRoot || expandedFolders.has(node.path);

  return (
    <div>
      {isRoot ? (
        <div onClick={() => onFolderSelected(null)} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36, padding: "6px 8px", marginBottom: 8, borderRadius: 6, cursor: "pointer", background: selectedFolderPath === null ? "#edf4ff" : "#f8fafc", border: selectedFolderPath === null ? "1px solid #d9e7ff" : "1px solid #e5e7eb", color: selectedFolderPath === null ? "#0b57d0" : "#1f2937", fontWeight: selectedFolderPath === null ? 700 : 600, fontSize: 13 }}>
          <span style={{ fontSize: 13 }}>📁</span>
          <span>All images</span>
          <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12 }}>{getFolderCountLabel(node, annotatedSet)}</span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30, padding: "4px 8px", margin: "2px 0", borderRadius: 6, cursor: "pointer", background: isSelectedFolder ? "#edf4ff" : "transparent", border: isSelectedFolder ? "1px solid #d9e7ff" : "1px solid transparent", color: isSelectedFolder ? "#0b57d0" : "#1f2937", fontWeight: isSelectedFolder ? 700 : 600, fontSize: 13 }}>
          <button type="button" onClick={() => onToggleFolder(node.path)} aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`} style={{ width: 20, height: 20, border: "1px solid #d1d5db", borderRadius: 6, background: "#ffffff", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, color: "#374151" }}>
            {node.children.length === 0 ? "•" : isExpanded ? "▾" : "▸"}
          </button>
          <div onClick={() => onFolderSelected(node.path)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13 }}>📁</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
            <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12 }}>{getFolderCountLabel(node, annotatedSet)}</span>
          </div>
        </div>
      )}

      {node.children.length > 0 && isExpanded && (
        <div style={{ paddingLeft: `${(level + 1) * 12}px` }}>
          {node.children.map((child) => (
            <TreeNodeView key={child.path} node={child} level={level + 1} selectedFolderPath={selectedFolderPath} selectedImagePath={selectedImagePath} expandedFolders={expandedFolders} annotatedSet={annotatedSet} noteSet={noteSet} notes={notes} filterMode={filterMode} onFolderSelected={onFolderSelected} onToggleFolder={onToggleFolder} onImageSelected={onImageSelected} />
          ))}
        </div>
      )}

      {isExpanded && node.images.map((image) => {
        const fullPath = node.path === "" ? image : `${node.path}/${image}`;
        const isSelectedImage = selectedImagePath === fullPath;
        const isAnnotated = Boolean(annotatedSet?.has(fullPath));
        const hasNote = Boolean(noteSet?.has(fullPath) || notes?.[fullPath]);
        
        const noteMeta = normalizeNoteValue(notes?.[fullPath]);
        const hasQuestion = Boolean(noteMeta.question.trim());
        const hasReply = Boolean(noteMeta.reply.trim());
        const hasComments = noteMeta.comments.length > 0;
        const isFlagged = noteMeta.flagged; // <-- Extracted flag

        const icon = hasReply ? "✅" : hasQuestion ? "❓" : hasComments ? "✎" : "";
        const iconColor = hasReply ? "#16a34a" : hasQuestion ? "#d97706" : hasComments ? "#2563eb" : "transparent";

        if (!matchesFilter(isAnnotated, hasNote, isFlagged, filterMode)) return null;

        return (
          <div key={fullPath} id={`file-${encodeURIComponent(fullPath)}`} onClick={() => onImageSelected(fullPath)} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26, padding: "4px 8px 4px 28px", margin: "1px 0", borderRadius: 6, cursor: "pointer", background: isSelectedImage ? "#edf4ff" : "transparent", border: isSelectedImage ? "1px solid #d9e7ff" : "1px solid transparent", color: isSelectedImage ? "#0b57d0" : "#4b5563", fontWeight: isSelectedImage ? 600 : 500, fontSize: 12 }}>
            <span style={{ width: 14, textAlign: "center", color: isAnnotated ? "#0b9538" : "transparent" }}>{isAnnotated ? "●" : ""}</span>
            
            {/* NEW: The Flag Icon Span! */}
            <span style={{ width: 14, textAlign: "center", fontSize: 11 }}>{isFlagged ? "🚩" : ""}</span>
            
            <span style={{ width: 18, textAlign: "center", color: iconColor, fontSize: 12, fontWeight: 700 }} title={hasReply ? "Answered question" : hasQuestion ? "Question" : hasComments ? "Comment" : ""}>
              {icon}
            </span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{image}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function FolderTree({ node, selectedFolderPath, selectedImagePath, expandedFolders, annotatedSet, noteSet, notes, filterMode = "all", onFolderSelected, onToggleFolder, onImageSelected }: FolderTreeProps) {
  const rawRoot = node.children.find((child) => child.name.toLowerCase() === "raw");
  const visibleNode = rawRoot ?? node;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rawRoot ? (
        <div onClick={() => onFolderSelected("raw")} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36, padding: "6px 8px", marginBottom: 8, borderRadius: 6, cursor: "pointer", background: selectedFolderPath === "raw" ? "#edf4ff" : "#f8fafc", border: selectedFolderPath === "raw" ? "1px solid #d9e7ff" : "1px solid #e5e7eb", color: selectedFolderPath === "raw" ? "#0b57d0" : "#1f2937", fontWeight: selectedFolderPath === "raw" ? 700 : 600, fontSize: 13 }}>
          <span style={{ fontSize: 13 }}>📁</span>
          <span>raw</span>
          <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12 }}>{getFolderCountLabel(rawRoot, annotatedSet)}</span>
        </div>
      ) : (
        <TreeNodeView node={visibleNode} selectedFolderPath={selectedFolderPath} selectedImagePath={selectedImagePath} expandedFolders={expandedFolders} annotatedSet={annotatedSet} noteSet={noteSet} notes={notes} filterMode={filterMode} onFolderSelected={onFolderSelected} onToggleFolder={onToggleFolder} onImageSelected={onImageSelected} />
      )}

      {rawRoot && (
        <div style={{ paddingLeft: 12 }}>
          {rawRoot.children.map((child) => (
            <TreeNodeView key={child.path} node={child} level={1} selectedFolderPath={selectedFolderPath} selectedImagePath={selectedImagePath} expandedFolders={expandedFolders} annotatedSet={annotatedSet} noteSet={noteSet} notes={notes} filterMode={filterMode} onFolderSelected={onFolderSelected} onToggleFolder={onToggleFolder} onImageSelected={onImageSelected} />
          ))}

          {rawRoot.images.map((image) => {
            const fullPath = `${rawRoot.path}/${image}`;
            const isSelectedImage = selectedImagePath === fullPath;
            const isAnnotated = Boolean(annotatedSet?.has(fullPath));
            const hasNote = Boolean(noteSet?.has(fullPath) || notes?.[fullPath]);
            
            const noteMeta = normalizeNoteValue(notes?.[fullPath]);
            const hasQuestion = Boolean(noteMeta.question.trim());
            const hasReply = Boolean(noteMeta.reply.trim());
            const hasComments = noteMeta.comments.length > 0;
            const isFlagged = noteMeta.flagged; // <-- Extracted flag

            const icon = hasReply ? "✅" : hasQuestion ? "❓" : hasComments ? "✎" : "";
            const iconColor = hasReply ? "#16a34a" : hasQuestion ? "#d97706" : hasComments ? "#2563eb" : "transparent";

            if (!matchesFilter(isAnnotated, hasNote, isFlagged, filterMode)) return null;

            return (
              <div key={fullPath} id={`file-${encodeURIComponent(fullPath)}`} onClick={() => onImageSelected(fullPath)} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26, padding: "4px 8px 4px 28px", margin: "1px 0", borderRadius: 6, cursor: "pointer", background: isSelectedImage ? "#edf4ff" : "transparent", border: isSelectedImage ? "1px solid #d9e7ff" : "1px solid transparent", color: isSelectedImage ? "#0b57d0" : "#4b5563", fontWeight: isSelectedImage ? 600 : 500, fontSize: 12 }}>
                <span style={{ width: 14, textAlign: "center", color: isAnnotated ? "#0b9538" : "transparent" }}>{isAnnotated ? "●" : ""}</span>
                
                {/* NEW: The Flag Icon Span! */}
                <span style={{ width: 14, textAlign: "center", fontSize: 11 }}>{isFlagged ? "🚩" : ""}</span>
                
                <span style={{ width: 18, textAlign: "center", color: iconColor, fontSize: 12, fontWeight: 700 }} title={hasReply ? "Answered question" : hasQuestion ? "Question" : hasComments ? "Comment" : ""}>
                  {icon}
                </span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{image}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
