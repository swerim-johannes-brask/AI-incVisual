import { useEffect, useMemo, useRef, useState } from "react";
import { decode } from "fast-png";
import UTIF from "utif";
import FolderTree from "./components/FolderTree";
import {
  loadImages,
  loadMasks,
  loadNotes,
  loadInclusionDictionary,
  saveNotes,
  type InclusionDictionaryEntry,
  type NoteValue,
} from "./services/azureBlobService";
import { buildTree } from "./services/treeBuilder";
import type { TreeNode } from "./types/DatasetTree";

type FilterMode = "all" | "annotated" | "unannotated" | "notes" | "flagged";

interface DatasetImage {
  name: string;
  path: string;
  url: string;
}

export default function App() {
  const [sasUrl, setSasUrl] = useState("");
  const [status, setStatus] = useState("Paste a SAS URL and click Connect");

  const [images, setImages] = useState<DatasetImage[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedImage, setSelectedImage] = useState<DatasetImage | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  const [isLoading, setIsLoading] = useState(false);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [masks, setMasks] = useState<Record<string, string>>({});
  const [annotatedSet, setAnnotatedSet] = useState<Set<string>>(new Set());
  const [noteSet, setNoteSet] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, NoteValue>>({});
  const [noteReplyDraft, setNoteReplyDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [selectedForDeletion, setSelectedForDeletion] = useState<Set<string>>(new Set());
  
  const [maskOverlayUrl, setMaskOverlayUrl] = useState<string | null>(null);
  const [instanceOverlayUrl, setInstanceOverlayUrl] = useState<string | null>(null);
  const [showMaskOverlay, setShowMaskOverlay] = useState(true);
  const [showInstanceOverlay, setShowInstanceOverlay] = useState(true);
  
  const [inclusionDictionary, setInclusionDictionary] = useState<InclusionDictionaryEntry[]>([]);
  const [maskIdsInImage, setMaskIdsInImage] = useState<Set<number>>(new Set());

  const [isFullscreen, setIsFullscreen] = useState(false);
  const imageCache = useRef<Record<string, { image: string | null; mask: string | null; instance: string | null; ids: number[] }>>({});
  
  const [isLegendCollapsed, setIsLegendCollapsed] = useState(false);
  
  const imagePanelRef = useRef<HTMLDivElement | null>(null);

  const selectedNote = useMemo(() => {
    if (!selectedImage) return null;
    return normalizeNoteValue(notes[selectedImage.path]);
  }, [notes, selectedImage]);

  const noteImages = useMemo(() => {
    return images
      .filter((image) => {
        const value = normalizeNoteValue(notes[image.path]);
        return value.question.trim().length > 0 || value.comments.length > 0;
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [images, notes]);

  useEffect(() => {
    let isCancelled = false;

    const loadPreview = async () => {
      if (!selectedImage) {
        setImagePreviewUrl(null); setMaskOverlayUrl(null); setInstanceOverlayUrl(null); setMaskIdsInImage(new Set());
        return;
      }

      // 1. Check if we already processed this image
      if (imageCache.current[selectedImage.path]) {
        const cached = imageCache.current[selectedImage.path];
        setImagePreviewUrl(cached.image);
        setMaskOverlayUrl(cached.mask);
        setInstanceOverlayUrl(cached.instance);
        setMaskIdsInImage(new Set(cached.ids));
        setImageLoadError(false);
        return;
      }

      try {
        setImageLoadError(false);
        let currentImage = null;
        let currentMask = null;
        let currentInstance = null;
        let currentIds: number[] = [];

        // 2. Load Base Image
        if (isTiffPath(selectedImage.path)) {
          currentImage = await tiffToPngDataUrl(selectedImage.url);
          if (!isCancelled) setImagePreviewUrl(currentImage);
        } else {
          currentImage = selectedImage.url;
          if (!isCancelled) setImagePreviewUrl(currentImage);
        }

        // 3. Load Overlays
        try {
          setMaskOverlayUrl(null); setInstanceOverlayUrl(null); setMaskIdsInImage(new Set());
          const { maskUrl, instanceUrl } = findOverlayUrls(selectedImage.path, masks);

          if (maskUrl) {
            const { url, presentIds } = await fetchAndColorizeMask(maskUrl);
            currentMask = url;
            currentIds = presentIds;
            if (!isCancelled) {
              setMaskOverlayUrl(currentMask);
              setMaskIdsInImage(new Set(currentIds));
            }
          }

          if (instanceUrl) {
            currentInstance = await fetchAndDrawBoundingBoxes(instanceUrl);
            if (!isCancelled) setInstanceOverlayUrl(currentInstance);
          }
        } catch (err) {
          console.warn("Failed to load mask overlays:", err);
        }

        // 4. Save to Cache for instant loading next time!
        if (!isCancelled) {
          imageCache.current[selectedImage.path] = {
            image: currentImage,
            mask: currentMask,
            instance: currentInstance,
            ids: currentIds
          };
        }
      } catch (error) {
        console.error("Failed to render image preview:", error);
        if (!isCancelled) { setImageLoadError(true); setImagePreviewUrl(null); }
      }
    };

    void loadPreview();
    return () => { isCancelled = true; };
  }, [selectedImage, masks]);

  const visibleImages = useMemo(() => {
    let baseImages = images;

    if (selectedFolderPath) {
      baseImages = images.filter((image) => {
        return (
          image.path === selectedFolderPath ||
          image.path.startsWith(`${selectedFolderPath}/`)
        );
      });
    }

    if (filterMode === "all") return baseImages;
    if (filterMode === "notes") return baseImages.filter((image) => noteSet.has(image.path));
    
    // NEW: Handle the flagged filter mode!
    if (filterMode === "flagged") return baseImages.filter((image) => {
      const noteMeta = normalizeNoteValue(notes[image.path]);
      return noteMeta.flagged;
    });

    return baseImages.filter((image) => {
      const isAnnotated = annotatedSet.has(image.path);
      return filterMode === "annotated" ? isAnnotated : !isAnnotated;
    });
  }, [images, selectedFolderPath, filterMode, annotatedSet, noteSet, notes]); // <-- Added 'notes' to dependencies here!

  const selectedImageIndex = useMemo(() => {
    if (!selectedImage) return -1;
    return visibleImages.findIndex((image) => image.path === selectedImage.path);
  }, [selectedImage, visibleImages]);

  const connectToContainer = async () => {
    const trimmedSasUrl = sasUrl.trim();

    if (!trimmedSasUrl) {
      setStatus("Please enter a SAS URL.");
      return;
    }

    try {
      setIsLoading(true);
      setStatus("Loading dataset...");
      setTree(null);
      setImages([]);
      setSelectedImage(null);
      setSelectedFolderPath(null);
      setImagePreviewUrl(null);
      setImageLoadError(false);
      setExpandedFolders(new Set());
      setMaskOverlayUrl(null);
      setInstanceOverlayUrl(null);
      setNoteReplyDraft("");
      setInclusionDictionary([]);

      // Load Inclusion Dictionary
      try {
        const dictionary = await loadInclusionDictionary(trimmedSasUrl);
        setInclusionDictionary(dictionary);
      } catch (err) {
        console.warn("Could not load inclusion dictionary:", err);
      }

      const loadedImages = (await loadImages(trimmedSasUrl)) as DatasetImage[];
      const validImages = loadedImages.filter(
        (image) =>
          typeof image.path === "string" &&
          typeof image.url === "string" &&
          !image.name.toLowerCase().includes("frameproperties")
      );

      const builtTree = buildTree(validImages.map((image) => image.path));
      const rootFolder = getPreferredRootFolder(validImages);

      const loadedMasks = await loadMasks(trimmedSasUrl);
      const maskMap: Record<string, string> = {};
      for (const m of loadedMasks) {
        maskMap[m.path] = m.url;
      }

      const loadedNotes = await loadNotes(trimmedSasUrl);
      const normalizedNotes: Record<string, NoteValue> = {};
      const nextNoteSet = new Set<string>();
      for (const [path, value] of Object.entries(loadedNotes)) {
        const normalized = normalizeNoteValue(value);
        if (!normalized.question.trim() && normalized.comments.length === 0) continue;
        normalizedNotes[path] = normalized;
        nextNoteSet.add(path);
      }

      const annotated = new Set<string>();
      
      for (const img of validImages) {
        // Only allow exact 1-to-1 path matches!
        const expectedMask = getExpectedMaskPath(img.path, "_mask.png");
        if (maskMap[expectedMask]) {
          annotated.add(img.path);
        }
      }

      setMasks(maskMap);
      setAnnotatedSet(annotated);
      setNotes(normalizedNotes);
      setNoteSet(nextNoteSet);

      setImages(validImages);
      setTree(builtTree);
      setExpandedFolders(new Set());
      setSelectedFolderPath(rootFolder);

      if (validImages.length > 0) {
        const firstImageInRoot = rootFolder
          ? validImages.find(
              (image) =>
                image.path === rootFolder ||
                image.path.startsWith(`${rootFolder}/`)
            ) ?? validImages[0]
          : validImages[0];

        const firstNote = normalizeNoteValue(notes[firstImageInRoot.path]);
        setSelectedImage(firstImageInRoot);
        setNoteReplyDraft(firstNote.reply);
        setStatus(
          rootFolder
            ? `Connected successfully. Showing ${rootFolder} images.`
            : `Connected successfully. Found ${validImages.length} images.`
        );
      } else {
        setStatus("Connected successfully, but no supported images were found.");
      }
    } catch (error: unknown) {
      console.error("Failed to connect to Azure Blob Storage:", error);
      if (error instanceof Error) {
        setStatus(`Connection failed: ${error.message}`);
      } else {
        setStatus("Connection failed because of an unknown error.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleFolderSelected = (folderPath: string | null) => {
    setSelectedFolderPath(folderPath);
    const folderImages = folderPath
      ? images.filter((image) => image.path === folderPath || image.path.startsWith(`${folderPath}/`))
      : images;

    const filteredFolderImages =
      filterMode === "all"
        ? folderImages
        : filterMode === "notes"
          ? folderImages.filter((image) => noteSet.has(image.path))
          : folderImages.filter((image) => {
              const isAnnotated = annotatedSet.has(image.path);
              return filterMode === "annotated" ? isAnnotated : !isAnnotated;
            });

    if (filteredFolderImages.length > 0) {
      setSelectedImage(filteredFolderImages[0]);
      setImageLoadError(false);
      setStatus(
        folderPath
          ? `Showing ${filteredFolderImages.length} image${filteredFolderImages.length === 1 ? "" : "s"} in ${folderPath}.`
          : `Showing all ${filteredFolderImages.length} images.`
      );
      return;
    }

    setSelectedImage(null);
    setImageLoadError(false);
    setStatus(folderPath ? `No images found in ${folderPath}.` : "No images found.");
  };

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
    // Removed the setTimeout block that forced the scroll
  };

  const handleImageSelected = (path: string) => {
    const image = images.find((candidate) => candidate.path === path);
    if (!image) {
      setStatus(`Could not find image: ${path}`);
      return;
    }

    const existing = normalizeNoteValue(notes[path]);
    setSelectedFolderPath(getParentFolderPath(path));
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (const folder of getAncestorFolderPaths(path)) next.add(folder);
      return next;
    });
    setImageLoadError(false);
    setSelectedImage(image);
    setNoteReplyDraft(existing.reply);
    setCommentDraft("");
  };

  const handleDeleteSelectedNotes = async () => {
    if (selectedForDeletion.size === 0) return;
    
    // 1. Show the confirmation popup!
    const confirmed = window.confirm(
      `You are about to delete notes for ${selectedForDeletion.size} image(s).\n\nThis will permanently remove their questions, replies, comments, and flags.\n\nAre you sure?`
    );
    if (!confirmed) return;

    // 2. Remove them from the dictionary
    const updatedNotes = { ...notes };
    for (const path of selectedForDeletion) {
      delete updatedNotes[path];
    }

    // 3. Recalculate the active notes set
    const nextNoteSet = new Set<string>();
    for (const [path, value] of Object.entries(updatedNotes)) {
      const normalized = normalizeNoteValue(value);
      if (normalized.question.trim() || normalized.comments.length > 0) nextNoteSet.add(path);
    }

    // 4. Update the UI
    setNotes(updatedNotes);
    setNoteSet(nextNoteSet);
    setSelectedForDeletion(new Set()); // Clear checkboxes

    // If the currently viewed image was just deleted, clear its drafts
    if (selectedImage && selectedForDeletion.has(selectedImage.path)) {
      setNoteReplyDraft("");
      setCommentDraft("");
    }

    // 5. Save to Azure
    try {
      await saveNotes(sasUrl.trim(), updatedNotes);
      setStatus(`Deleted notes for ${selectedForDeletion.size} images.`);
    } catch (error) {
      console.error("Failed to delete notes:", error);
      setStatus("Failed to delete notes from Azure.");
    }
  };

  const handleSaveReply = async () => {
    if (!selectedImage) return;
    const existing = normalizeNoteValue(notes[selectedImage.path]);
    const trimmedReply = noteReplyDraft.trim();
    const updatedObject: Record<string, string | boolean | string[] | undefined> = {
      question: existing.question || selectedImage.name,
      comments: existing.comments,
      answered: trimmedReply.length > 0,
    };

    if (trimmedReply) updatedObject.reply = trimmedReply;

    const updatedNotes: Record<string, NoteValue> = {
      ...notes,
      [selectedImage.path]: Object.fromEntries(
        Object.entries(updatedObject).filter(([, value]) => value !== undefined)
      ) as Record<string, unknown> as NoteValue,
    };

    const nextNoteSet = new Set<string>();
    for (const [path, value] of Object.entries(updatedNotes)) {
      const normalized = normalizeNoteValue(value);
      if (normalized.question.trim() || normalized.comments.length > 0) nextNoteSet.add(path);
    }

    setNotes(updatedNotes);
    setNoteSet(nextNoteSet);
    setNoteReplyDraft(trimmedReply);

    try {
      await saveNotes(sasUrl.trim(), updatedNotes);
      setStatus(trimmedReply ? `Saved reply for ${selectedImage.path}.` : `Removed reply for ${selectedImage.path}.`);
    } catch (error) {
      console.error("Failed to save note reply:", error);
      setStatus("Failed to save reply to notes.json.");
    }
  };

  const handleToggleFlag = async () => {
    if (!selectedImage) return;
    const existing = normalizeNoteValue(notes[selectedImage.path]);
    const newFlagState = !existing.flagged;

    const existingObject = typeof notes[selectedImage.path] === 'object' ? notes[selectedImage.path] : {};
    
    const updatedNotes = {
      ...notes,
      [selectedImage.path]: {
        ...(existingObject as object),
        flagged: newFlagState,
      } as NoteValue,
    };

    setNotes(updatedNotes);
    
    try {
      await saveNotes(sasUrl.trim(), updatedNotes);
      setStatus(newFlagState ? `Flagged ${selectedImage.name}` : `Removed flag from ${selectedImage.name}`);
    } catch (error) {
      console.error("Failed to save flag:", error);
      setStatus("Failed to save flag to notes.json.");
    }
  };
  

  const handleSaveComment = async () => {
    if (!selectedImage) return;
    const trimmedComment = commentDraft.trim();
    if (!trimmedComment) return;

    const existing = normalizeNoteValue(notes[selectedImage.path]);
    const updatedComments = [...existing.comments, trimmedComment];
    const updatedNotes: Record<string, NoteValue> = {
      ...notes,
      [selectedImage.path]: {
        question: existing.question,
        reply: existing.reply,
        comments: updatedComments,
        answered: existing.answered || Boolean(existing.reply),
      },
    };

    const nextNoteSet = new Set<string>();
    for (const [path, value] of Object.entries(updatedNotes)) {
      const normalized = normalizeNoteValue(value);
      if (normalized.question.trim() || normalized.comments.length > 0) nextNoteSet.add(path);
    }

    setNotes(updatedNotes);
    setNoteSet(nextNoteSet);
    setCommentDraft("");

    try {
      await saveNotes(sasUrl.trim(), updatedNotes);
      setStatus(`Saved comment for ${selectedImage.path}.`);
    } catch (error) {
      console.error("Failed to save comment:", error);
      setStatus("Failed to save comment to notes.json.");
    }
  };

  const selectPreviousImage = () => {
    if (selectedImageIndex <= 0) return;
    const nextImage = visibleImages[selectedImageIndex - 1];
    const nextReply = normalizeNoteValue(notes[nextImage.path]).reply;
    setImageLoadError(false);
    setSelectedImage(nextImage);
    setSelectedFolderPath(getParentFolderPath(nextImage.path));
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (const folder of getAncestorFolderPaths(nextImage.path)) next.add(folder);
      return next;
    });
    setNoteReplyDraft(nextReply);
    setCommentDraft("");
  };

  const selectNextImage = () => {
    if (selectedImageIndex < 0 || selectedImageIndex >= visibleImages.length - 1) return;
    const nextImage = visibleImages[selectedImageIndex + 1];
    const nextReply = normalizeNoteValue(notes[nextImage.path]).reply;
    setImageLoadError(false);
    setSelectedImage(nextImage);
    setSelectedFolderPath(getParentFolderPath(nextImage.path));
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (const folder of getAncestorFolderPaths(nextImage.path)) next.add(folder);
      return next;
    });
    setNoteReplyDraft(nextReply);
    setCommentDraft("");
  };

  const handleSasUrlKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !isLoading) void connectToContainer();
  };

  useEffect(() => {
    if (!selectedImage) return;
    
    // Use a small timeout to allow the folder tree to render newly expanded folders
    // before attempting to scroll to the image.
    const timer = setTimeout(() => {
      const element = document.getElementById(`file-${encodeURIComponent(selectedImage.path)}`);
      if (element) element.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);

    return () => clearTimeout(timer);
  }, [selectedImage]); // <-- Removed expandedFolders from here

  const legendEntries = useMemo(() => {
    const byId = new Map<number, InclusionDictionaryEntry>();
    for (const entry of inclusionDictionary) {
      byId.set(entry.id, entry);
    }
    for (const id of maskIdsInImage) {
      if (!byId.has(id)) byId.set(id, { id, name: `ID ${id}` });
    }
    return Array.from(byId.values()).sort((a, b) => a.id - b.id);
  }, [inclusionDictionary, maskIdsInImage]);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        color: "#242424",
        background: "#ffffff",
        margin: 0,
        padding: 0,
      }}
    >
      <header
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          borderBottom: "1px solid #dddddd",
          background: "#ffffff",
        }}
      >
        <input
          type="password"
          value={sasUrl}
          onChange={(event) => setSasUrl(event.target.value)}
          onKeyDown={handleSasUrlKeyDown}
          placeholder="Paste Azure Blob container SAS URL..."
          aria-label="Azure Blob container SAS URL"
          disabled={isLoading}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "10px 12px",
            border: "1px solid #b3b3b3",
            borderRadius: "4px",
            fontSize: "14px",
          }}
        />
        <button
          type="button"
          onClick={() => void connectToContainer()}
          disabled={isLoading || sasUrl.trim().length === 0}
          style={{
            padding: "10px 20px",
            border: 0,
            borderRadius: "4px",
            background: isLoading || sasUrl.trim().length === 0 ? "#a0a0a0" : "#0067b8",
            color: "#ffffff",
            fontWeight: 600,
            cursor: isLoading || sasUrl.trim().length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {isLoading ? "Connecting..." : "Connect"}
        </button>
      </header>

      <div
        role="status"
        aria-live="polite"
        style={{
          padding: "4px 16px",
          background: "#f5f5f5",
          borderBottom: "1px solid #dddddd",
          fontSize: "12px",
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {status}
        </span>
        
        <span style={{ fontWeight: 600, color: "#444" }}>
          Images: {visibleImages.length}
        </span>

        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: "11px", justifyContent: "flex-end", minWidth: 0 }}>
          {selectedImage && (
            <>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <strong style={{ color: "#6b7280", fontSize: "10px" }}>PATH:</strong>{" "}
                <span style={{ color: "#555555" }}>{selectedImage.path}</span>
              </div>
              <a href={selectedImage.url} target="_blank" rel="noreferrer" style={{ color: "#2563eb", textDecoration: "none", fontSize: "11px", whiteSpace: "nowrap" }}>
                Open →
              </a>
            </>
          )}
        </div>
      </div>

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "minmax(280px, 250px) 1fr minmax(260px, 320px)",
          overflow: "hidden",
        }}
      >
        <aside style={{ minWidth: 0, padding: "12px", overflow: "auto", borderRight: "1px solid #dddddd" }}>
          <h2 style={{ margin: "0 0 12px", fontSize: "18px" }}>Folder Tree</h2>
          {isLoading ? (
            <p>Loading dataset...</p>
          ) : tree ? (
            <FolderTree
              node={tree}
              selectedFolderPath={selectedFolderPath}
              selectedImagePath={selectedImage?.path ?? null}
              expandedFolders={expandedFolders}
              annotatedSet={annotatedSet}
              noteSet={noteSet}
              notes={notes}
              filterMode={filterMode}
              onFolderSelected={handleFolderSelected}
              onToggleFolder={handleToggleFolder}
              onImageSelected={handleImageSelected}
            />
          ) : (
            <p style={{ color: "#666666" }}>No dataset loaded.</p>
          )}
        </aside>

        <section style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "#f8f8f8" }}>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              padding: "20px",
              overflow: "hidden",
            }}
          >
            {selectedImage ? (
              imageLoadError ? (
                <div
                  style={{
                    maxWidth: "500px",
                    padding: "20px",
                    border: "1px solid #d13438",
                    borderRadius: "6px",
                    background: "#ffffff",
                    color: "#a4262c",
                    textAlign: "center",
                  }}
                >
                  The image could not be loaded.
                  <br />
                  Check that the SAS token has read permission and has not expired.
                </div>
              ) : (
                <div
                  ref={imagePanelRef}
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    flexDirection: "row",
                    background: "#ffffff",
                    boxShadow: "0 2px 12px rgba(0, 0, 0, 0.12)",
                    overflow: "hidden",
                  }}
                >
                  {/* IMAGE AREA */}
                  <div
                    onDoubleClick={() => setIsFullscreen(true)} // <-- ADD THIS 
                    style={{
                      flex: 1,
                      position: "relative",
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      minWidth: 0, // Prevents flexbox from overflowing
                      cursor: "zoom-in" // <-- ADD THIS
                    }}>
                    <img
                      key={`${selectedImage.path}-base`}
                      src={imagePreviewUrl ?? selectedImage.url}
                      alt={selectedImage.name || getFileName(selectedImage.path)}
                      style={{
                        display: "block",
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                      }}
                    />

                    {maskOverlayUrl && showMaskOverlay && (
                      <img
                        key={`${selectedImage.path}-mask`}
                        src={maskOverlayUrl}
                        alt="mask overlay"
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          pointerEvents: "none",
                          opacity: 0.9,
                        }}
                      />
                    )}

                    {instanceOverlayUrl && showInstanceOverlay && (
                      <img
                        key={`${selectedImage.path}-instance`}
                        src={instanceOverlayUrl}
                        alt="instance overlay"
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          pointerEvents: "none",
                          opacity: 0.95,
                        }}
                      />
                    )}
                  </div>

                  {/* PINNED LEGEND */}
                  {inclusionDictionary.length > 0 && (
                    <div
                      style={{
                        width: isLegendCollapsed ? "40px" : "120px",
                        height: "100%",
                        background: "#f9f9f9",
                        borderLeft: "1px solid #e5e7eb",
                        display: "flex",
                        flexDirection: "column",
                        transition: "width 0.2s ease-in-out",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: isLegendCollapsed ? "center" : "space-between",
                          alignItems: "center",
                          padding: "10px",
                          borderBottom: "1px solid #e5e7eb",
                          background: "#f1f5f9",
                        }}
                      >
                        {!isLegendCollapsed && (
                          <span style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>
                            CLASS LEGEND
                          </span>
                        )}
                        <button
                          onClick={() => setIsLegendCollapsed(!isLegendCollapsed)}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "14px",
                            padding: "0 4px",
                            color: "#64748b",
                          }}
                          title={isLegendCollapsed ? "Expand Legend" : "Collapse Legend"}
                        >
                          {isLegendCollapsed ? "◀" : "▶"}
                        </button>
                      </div>

                      {!isLegendCollapsed && (
                        <div
                          style={{
                            padding: "12px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                            overflowY: "auto",
                            flex: 1,
                          }}
                        >
                          {legendEntries.map((entry) => {
                            const color = getColorForId(entry.id);
                            const isPresent = maskIdsInImage.has(entry.id);
                            return (
                              <div
                                key={entry.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "10px",
                                  opacity: isPresent ? 1 : 0.4,
                                }}
                              >
                                <div
                                  style={{
                                    width: "14px",
                                    height: "14px",
                                    backgroundColor: `rgb(${color.join(",")})`,
                                    border: "1px solid #94a3b8",
                                    borderRadius: "3px",
                                    flexShrink: 0,
                                  }}
                                />
                                <span
                                  style={{
                                    fontSize: "12px",
                                    fontWeight: isPresent ? 600 : 400,
                                    color: "#334155",
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {entry.id} - {entry.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            ) : (
              <p style={{ color: "#666666" }}>Select an image from the folder tree.</p>
            )}
          </div>

          <div style={{ minHeight: "28px", display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", padding: "6px 12px", borderTop: "1px solid #334155", background: "#1e293b" }}>
            
            {/* NEW FLAG BUTTON */}
            <button 
              onClick={handleToggleFlag} 
              disabled={!selectedImage}
              style={{ 
                background: "none", border: "none", cursor: selectedImage ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", gap: 4, marginRight: 16,
                color: selectedImage && normalizeNoteValue(notes[selectedImage.path]).flagged ? "#ef4444" : "#64748b",
                fontWeight: 600, fontSize: "12px"
              }}
            >
              {selectedImage && normalizeNoteValue(notes[selectedImage.path]).flagged ? "🚩" : "🏳️"}
            </button>

            <div style={{ display: "flex", gap: 12, alignItems: "center", marginRight: 8 }}>
              <label style={{ fontSize: 11, color: "#cbd5e1", display: "flex", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={showMaskOverlay} onChange={(e) => setShowMaskOverlay(e.target.checked)} style={{ marginRight: 6, accentColor: "#3b82f6" }} /> Mask
              </label>
              <label style={{ fontSize: 11, color: "#cbd5e1", display: "flex", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={showInstanceOverlay} onChange={(e) => setShowInstanceOverlay(e.target.checked)} style={{ marginRight: 6, accentColor: "#3b82f6" }} /> BB
              </label>
            </div>

            {/* UPDATED FILTERS TO INCLUDE "flagged" */}
            <div style={{ display: "flex", gap: 4, alignItems: "center", borderLeft: "1px solid #334155", paddingLeft: 12 }}>
              {(["all", "annotated", "unannotated", "notes", "flagged"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFilterMode(mode as any)}
                  style={{
                    border: filterMode === mode ? "1px solid #3b82f6" : "1px solid #475569",
                    background: filterMode === mode ? "#1e3a8a" : "#0f172a",
                    color: filterMode === mode ? "#bfdbfe" : "#94a3b8",
                    borderRadius: 4, padding: "4px 8px", fontSize: 10, fontWeight: filterMode === mode ? 600 : 400, cursor: "pointer",
                  }}
                >
                  {mode === "all" ? "All" : mode === "annotated" ? "Ann." : mode === "unannotated" ? "Unann." : mode === "notes" ? "Notes" : "Flagged"}
                </button>
              ))}
            </div>
            
            <div style={{ flex: 1 }} />

            <button type="button" onClick={selectPreviousImage} disabled={selectedImageIndex <= 0} style={navigationButtonStyle(selectedImageIndex <= 0)}>
              Prev
            </button>

            <span style={{ minWidth: "60px", textAlign: "center", fontSize: "11px", fontWeight: 500 }}>
              {selectedImageIndex >= 0 ? `${selectedImageIndex + 1} / ${visibleImages.length}` : `0 / ${visibleImages.length}`}
            </span>

            <button
              type="button"
              onClick={selectNextImage}
              disabled={selectedImageIndex < 0 || selectedImageIndex >= visibleImages.length - 1}
              style={navigationButtonStyle(selectedImageIndex < 0 || selectedImageIndex >= visibleImages.length - 1)}
            >
              Next
            </button>
          </div>
        </section>

        <aside
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid #dddddd",
            background: "#ffffff",
            overflow: "hidden",
          }}
        >
          {selectedImage ? (
            <>
              {/* TOP ZONE: Locked to exactly 45% height */}
              <div
                style={{
                  padding: "12px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  flex: "0 0 40%", // strictly locks height to 45% of the sidebar
                  overflowY: "auto", // internal scrollbar for long text
                  borderBottom: "2px solid #e5e7eb",
                }}
              >
                {selectedNote && (selectedNote.question || selectedNote.comments.length > 0 || selectedNote.reply) ? (
                  <>
                    {selectedNote.question ? (
                      <div style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid #78350f", 
                        background: selectedNote.answered ? "#064e3b" : "#451a03", // <-- Changed to .answered
                        color: selectedNote.answered ? "#d1fae5" : "#fef3c7",      // <-- Changed to .answered
                        whiteSpace: "pre-wrap", fontSize: "11px" 
                      }}>
                        <div style={{ fontSize: 9, fontWeight: 700, 
                          color: selectedNote.answered ? "#10b981" : "#f59e0b",    // <-- Changed to .answered
                          marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" 
                        }}>
                          {selectedNote.answered ? "Answered question" : "Question"} {/* <-- Changed to .answered */}
                        </div>
                        {selectedNote.question}
                      </div>
                    ) : null}

                    {selectedNote.reply ? (
                      <div style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid #d1fae5", background: "#ecfdf5", color: "#065f46", whiteSpace: "pre-wrap", fontSize: "11px" }}>
                        <strong style={{ display: "block", marginBottom: 4, fontSize: "10px", textTransform: "uppercase" }}>Reply</strong>
                        {selectedNote.reply}
                      </div>
                    ) : null}

                    {selectedNote.comments.length > 0 ? (
                      <div style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid #dbeafe", background: "#eff6ff", color: "#1d4ed8", fontSize: "11px" }}>
                        <strong style={{ display: "block", marginBottom: 6, fontSize: "10px", textTransform: "uppercase" }}>Comments</strong>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {selectedNote.comments.map((comment, index) => (
                            <div key={`${comment}-${index}`} style={{ padding: "6px 8px", borderRadius: 6, background: "#ffffff", border: "1px solid #dbeafe", whiteSpace: "pre-wrap" }}>
                              {comment}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "auto" }}>
                      {selectedNote.question ? (
                        <>
                          <textarea
                            value={noteReplyDraft}
                            onChange={(event) => setNoteReplyDraft(event.target.value)}
                            placeholder="Write a reply to this question..."
                            rows={2}
                            style={{ width: "100%", resize: "vertical", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d1d5db", fontFamily: "inherit", fontSize: "11px", boxSizing: "border-box" }}
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveReply()}
                            disabled={!selectedNote.question || (!selectedNote.reply.trim() && !noteReplyDraft.trim())}
                            style={{
                              padding: "6px 12px", border: "1px solid #0b57d0", borderRadius: "6px",
                              background: selectedNote.reply.trim() || noteReplyDraft.trim() ? "#0b57d0" : "#e5e7eb",
                              color: selectedNote.reply.trim() || noteReplyDraft.trim() ? "#ffffff" : "#6b7280",
                              cursor: selectedNote.reply.trim() || noteReplyDraft.trim() ? "pointer" : "not-allowed",
                              fontWeight: 600, fontSize: "11px"
                            }}
                          >
                            {selectedNote.reply ? "Update reply" : "Save reply"}
                          </button>
                        </>
                      ) : null}

                      {!selectedNote.question ? (
                        <>
                          <textarea
                            value={commentDraft}
                            onChange={(event) => setCommentDraft(event.target.value)}
                            placeholder="Add an image comment..."
                            rows={2}
                            style={{ width: "100%", resize: "vertical", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d1d5db", fontFamily: "inherit", fontSize: "11px", boxSizing: "border-box" }}
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveComment()}
                            disabled={!commentDraft.trim()}
                            style={{
                              padding: "6px 12px", border: "1px solid #2563eb", borderRadius: "6px",
                              background: commentDraft.trim() ? "#2563eb" : "#e5e7eb",
                              color: commentDraft.trim() ? "#ffffff" : "#6b7280",
                              cursor: commentDraft.trim() ? "pointer" : "not-allowed",
                              fontWeight: 600, fontSize: "11px"
                            }}
                          >
                            Add comment
                          </button>
                        </>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ color: "#6b7280", fontSize: 11 }}>No saved question or comments for this image.</div>
                    <textarea
                      value={commentDraft}
                      onChange={(event) => setCommentDraft(event.target.value)}
                      placeholder="Add the first comment to this image..."
                      rows={2}
                      style={{ width: "100%", resize: "vertical", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d1d5db", fontFamily: "inherit", fontSize: "11px", boxSizing: "border-box" }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveComment()}
                      disabled={!commentDraft.trim()}
                      style={{
                        padding: "6px 12px", border: "1px solid #2563eb", borderRadius: "6px",
                        background: commentDraft.trim() ? "#2563eb" : "#e5e7eb",
                        color: commentDraft.trim() ? "#ffffff" : "#6b7280",
                        cursor: commentDraft.trim() ? "pointer" : "not-allowed",
                        fontWeight: 600, fontSize: "11px"
                      }}
                    >
                      Add comment
                    </button>
                  </div>
                )}
              </div>

              {/* BOTTOM ZONE: Note Directory List */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "12px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  background: "#f9fafb"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>
                    Notes Directory
                  </div>
                  
                  {/* NEW: Delete Button appears if items are checked */}
                  {selectedForDeletion.size > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteSelectedNotes()}
                      style={{
                        padding: "2px 8px", fontSize: "10px", fontWeight: 600, color: "#ffffff",
                        background: "#ef4444", border: "none", borderRadius: "4px", cursor: "pointer"
                      }}
                    >
                      Delete Selected ({selectedForDeletion.size})
                    </button>
                  )}
                </div>

                {noteImages.length > 0 ? (
                  [...noteImages].sort((a, b) => {
                    const valA = normalizeNoteValue(notes[a.path]);
                    const valB = normalizeNoteValue(notes[b.path]);
                    
                    const isUnansweredA = valA.question.trim().length > 0 && valA.answered !== true;
                    const isUnansweredB = valB.question.trim().length > 0 && valB.answered !== true;
                    
                    if (isUnansweredA && !isUnansweredB) return -1;
                    if (!isUnansweredA && isUnansweredB) return 1; 
                    return 0;
                    
                  }).map((image) => {
                    const value = normalizeNoteValue(notes[image.path]);
                    const hasQuestion = value.question.trim().length > 0;
                    const isAnswered = value.answered === true; 
                    const statusColor = isAnswered ? "#10b981" : hasQuestion ? "#f59e0b" : "#3b82f6";
                    const statusText = isAnswered ? "answered" : hasQuestion ? "question" : "comment";
                    
                    return (
                      <div key={image.path} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {/* NEW: The Checkbox */}
                        <input
                          type="checkbox"
                          checked={selectedForDeletion.has(image.path)}
                          onChange={(e) => {
                            const next = new Set(selectedForDeletion);
                            if (e.target.checked) next.add(image.path);
                            else next.delete(image.path);
                            setSelectedForDeletion(next);
                          }}
                          style={{ cursor: "pointer", accentColor: "#ef4444" }}
                          title="Select for deletion"
                        />
                        
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedImage(image);
                            setSelectedFolderPath(getParentFolderPath(image.path));
                            setExpandedFolders((current) => {
                              const next = new Set(current);
                              for (const folder of getAncestorFolderPaths(image.path)) next.add(folder);
                              return next;
                            });
                            setNoteReplyDraft("");
                            setCommentDraft("");
                          }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                            flex: 1, padding: "6px 8px", borderRadius: 4,
                            border: selectedImage?.path === image.path ? "1px solid #3b82f6" : "1px solid #334155",
                            background: selectedImage?.path === image.path ? "#1e3a8a" : "#1e293b",
                            cursor: "pointer", textAlign: "left", color: "#e2e8f0", minWidth: 0
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px" }}>
                            {image.name || getFileName(image.path)}
                          </span>
                          
                          <span style={{ color: statusColor, fontSize: 11, flexShrink: 0 }} title={statusText}>
                            {isAnswered ? "✅" : hasQuestion ? "❓" : "✎"}
                          </span>
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ color: "#64748b", fontSize: 11 }}>No images currently have questions or comments.</div>
                )}
              </div>
            </>
          ) : (
            <p style={{ color: "#666666", padding: "12px", fontSize: "11px" }}>No image selected.</p>
          )}
        </aside>
      </main>

      {/* FULLSCREEN MODAL */}
      {isFullscreen && selectedImage && (
        <div
          style={{
            position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
            background: "rgba(0, 0, 0, 0.95)", zIndex: 9999,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center"
          }}
        >
          {/* Close Button */}
          <button
            onClick={() => setIsFullscreen(false)}
            style={{
              position: "absolute", top: "20px", right: "30px",
              background: "none", border: "none", color: "#ffffff",
              fontSize: "36px", cursor: "pointer", zIndex: 10000
            }}
          >
            ✕
          </button>

          {/* Modal Image Area */}
          <div style={{ position: "relative", width: "90vw", height: "85vh", display: "flex", justifyContent: "center" }}>
            <img src={imagePreviewUrl ?? selectedImage.url} alt="fullscreen base" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            
            {maskOverlayUrl && showMaskOverlay && (
              <img src={maskOverlayUrl} alt="fullscreen mask" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "contain", opacity: 0.9, pointerEvents: "none" }} />
            )}
            
            {instanceOverlayUrl && showInstanceOverlay && (
              <img src={instanceOverlayUrl} alt="fullscreen instances" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "contain", opacity: 0.95, pointerEvents: "none" }} />
            )}
          </div>

          {/* Modal Controls */}
          <div style={{ display: "flex", gap: "20px", marginTop: "20px", background: "#ffffff", padding: "10px 24px", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
            <label style={{ fontSize: 14, fontWeight: 600, color: "#333", cursor: "pointer" }}>
              <input type="checkbox" checked={showMaskOverlay} onChange={(e) => setShowMaskOverlay(e.target.checked)} style={{ marginRight: 8 }} />
              Show mask
            </label>
            <label style={{ fontSize: 14, fontWeight: 600, color: "#333", cursor: "pointer" }}>
              <input type="checkbox" checked={showInstanceOverlay} onChange={(e) => setShowInstanceOverlay(e.target.checked)} style={{ marginRight: 8 }} />
              Show BB
            </label>
          </div>
        </div>
      )}

    </div>
  );
}

// Generate consistent RGB colors based on ID mapping to HSL
function getColorForId(id: number): [number, number, number] {
  const hue = (id * 137.508) % 360; // Golden angle for even distribution
  const s = 0.7;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  
  if (hue >= 0 && hue < 60) { r = c; g = x; b = 0; }
  else if (hue >= 60 && hue < 120) { r = x; g = c; b = 0; }
  else if (hue >= 120 && hue < 180) { r = 0; g = c; b = x; }
  else if (hue >= 180 && hue < 240) { r = 0; g = x; b = c; }
  else if (hue >= 240 && hue < 300) { r = x; g = 0; b = c; }
  else if (hue >= 300 && hue < 360) { r = c; g = 0; b = x; }
  
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function getParentFolderPath(path: string): string | null {
  const normalized = path.trim();
  if (!normalized) return null;
  const fragments = normalized.split("/");
  if (fragments.length <= 1) return null;
  fragments.pop();
  return fragments.join("/");
}

function isTiffPath(path: string): boolean {
  return /\.(tif|tiff)$/i.test(path);
}

function getExpectedMaskPath(imagePath: string, suffix: "_mask.png" | "_instance.png"): string {
  const segments = imagePath.split("/");
  
  // 1. Find where "raw" is in the folder tree and swap it to "masks"
  const rawIndex = segments.findIndex((s) => s.toLowerCase() === "raw");
  if (rawIndex !== -1) {
    segments[rawIndex] = "masks";
  } else {
    // Fallback just in case "raw" is missing
    segments.unshift("masks"); 
  }
  
  // 2. Strip the old extension (.tiff, .bmp) and add the new suffix
  const filename = segments[segments.length - 1];
  const lastDotIndex = filename.lastIndexOf(".");
  const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
  
  segments[segments.length - 1] = `${baseName}${suffix}`;
  
  return segments.join("/");
}

function normalizeNoteValue(value: NoteValue | undefined): {
  question: string;
  reply: string;
  comments: string[];
  answered: boolean;
  flagged: boolean; // <-- NEW
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
      
  const isAnswered = typeof value.answered === "boolean" ? value.answered : Boolean(reply);
  const flagged = Boolean(value.flagged); // <-- NEW

  return { question, reply, comments, answered: isAnswered, flagged }; // <-- NEW
}

async function tiffToPngDataUrl(tiffUrl: string): Promise<string> {
  const response = await fetch(tiffUrl);
  if (!response.ok) throw new Error(`Failed to fetch TIFF image: ${response.statusText}`);
  const tiffBuffer = await response.arrayBuffer();
  const ifd = UTIF.decode(tiffBuffer);
  if (!ifd || ifd.length === 0) throw new Error("TIFF could not be decoded.");
  const firstImage = ifd[0];
  UTIF.decodeImage(tiffBuffer, firstImage);
  const rgba = UTIF.toRGBA8(firstImage);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  canvas.width = firstImage.width;
  canvas.height = firstImage.height;
  const imageData = new ImageData(new Uint8ClampedArray(rgba), firstImage.width, firstImage.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function fetchAndColorizeMask(maskUrl: string, isInstance = false): Promise<{ url: string; presentIds: number[] }> {
  const res = await fetch(maskUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch mask: ${res.statusText}`);

  const blob = await res.blob();
  const img = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const labelSet = new Set<number>();

  for (let i = 0; i < data.length; i += 4) {
    const value = Math.max(data[i], data[i + 1], data[i + 2]);
    if (value > 0) labelSet.add(value);
  }

  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const label = Math.max(r, g, b);

    if (label === 0) {
      out[i + 3] = 0;
      continue;
    }

    const color = getColorForId(label);
    out[i] = color[0];
    out[i + 1] = color[1];
    out[i + 2] = color[2];
    out[i + 3] = isInstance ? 180 : 140;
  }

  const outImage = new ImageData(out, canvas.width, canvas.height);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = canvas.width;
  outCanvas.height = canvas.height;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("Canvas not supported");
  outCtx.putImageData(outImage, 0, 0);

  return { url: outCanvas.toDataURL("image/png"), presentIds: Array.from(labelSet) };
}

function navigationButtonStyle(disabled: boolean): React.CSSProperties {
  return { 
    padding: "2px 8px", 
    fontSize: "10px",
    border: "1px solid #b3b3b3", 
    borderRadius: "4px", 
    background: disabled ? "#eeeeee" : "#ffffff", 
    color: disabled ? "#888888" : "#242424", 
    cursor: disabled ? "not-allowed" : "pointer" 
  };
}

function getPreferredRootFolder(images: DatasetImage[]): string | null {
  const rawFolder = images.find((image) => image.path.split("/").some((segment) => segment.toLowerCase() === "raw"));
  if (!rawFolder) return null;
  const segments = rawFolder.path.split("/");
  const rawIndex = segments.findIndex((segment) => segment.toLowerCase() === "raw");
  if (rawIndex === -1) return null;
  return segments.slice(0, rawIndex + 1).join("/");
}


function findOverlayUrls(imagePath: string, masks: Record<string, string>): { maskUrl?: string; instanceUrl?: string } {
  // Calculate the exact paths we expect to find in Azure
  const targetMaskPath = getExpectedMaskPath(imagePath, "_mask.png");
  const targetInstancePath = getExpectedMaskPath(imagePath, "_instance.png");
  
  // Only return the URLs if the exact folder path matches
  return {
    maskUrl: masks[targetMaskPath],
    instanceUrl: masks[targetInstancePath]
  };
}

function getAncestorFolderPaths(imagePath: string): string[] {
  const paths: string[] = [];
  let current: string | null = imagePath;
  while (current) {
    const parent = getParentFolderPath(current);
    if (!parent) break;
    paths.push(parent);
    current = parent;
  }
  return paths;
}

async function fetchAndDrawBoundingBoxes(instanceUrl: string): Promise<string> {
  const res = await fetch(instanceUrl);
  if (!res.ok) throw new Error(`Failed to fetch instance mask: ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  // Decode the raw 16-bit PNG data
  const png = decode(buffer);

  const canvas = document.createElement("canvas");
  canvas.width = png.width;
  canvas.height = png.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  const boxes = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  
  // png.data will accurately preserve the 16-bit integers
  const data = png.data;
  const width = png.width;
  const height = png.height;
  const channels = png.channels; // 1 for grayscale

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const id = data[idx];

      if (id === 0) continue; // Skip background

      if (!boxes.has(id)) {
        boxes.set(id, { minX: x, minY: y, maxX: x, maxY: y });
      } else {
        const box = boxes.get(id)!;
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
      }
    }
  }

  // Draw the crisp bounding boxes onto a transparent background
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#000000"; // Bright neon green
  ctx.lineWidth = 2;

  for (const box of boxes.values()) {
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    ctx.strokeRect(box.minX, box.minY, w || 1, h || 1);
  }

  return canvas.toDataURL("image/png");
}