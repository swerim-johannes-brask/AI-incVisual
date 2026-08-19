import { useEffect, useMemo, useState } from "react";
import UTIF from "utif";
import FolderTree from "./components/FolderTree";
import { loadImages, loadMasks } from "./services/azureBlobService";
import { buildTree } from "./services/treeBuilder";
import type { TreeNode } from "./types/DatasetTree";

type FilterMode = "all" | "annotated" | "unannotated";

interface DatasetImage {
  name: string;
  path: string;
  url: string;
}

export default function App() {
  const [sasUrl, setSasUrl] = useState("");
  const [status, setStatus] = useState(
    "Paste a SAS URL and click Connect"
  );

  const [images, setImages] = useState<DatasetImage[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedImage, setSelectedImage] =
    useState<DatasetImage | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] =
    useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<
    Set<string>
  >(new Set());
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  const [isLoading, setIsLoading] = useState(false);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<
    string | null
  >(null);
  const [masks, setMasks] = useState<Record<string, string>>({});
  const [annotatedSet, setAnnotatedSet] = useState<Set<string>>(new Set());
  const [maskOverlayUrl, setMaskOverlayUrl] = useState<string | null>(null);
  const [instanceOverlayUrl, setInstanceOverlayUrl] = useState<string | null>(null);
  const [showMaskOverlay, setShowMaskOverlay] = useState(true);
  const [showInstanceOverlay, setShowInstanceOverlay] = useState(true);

  useEffect(() => {
    let isCancelled = false;

    const loadPreview = async () => {
      if (!selectedImage) {
        setImagePreviewUrl(null);
        setMaskOverlayUrl(null);
        setInstanceOverlayUrl(null);
        return;
      }

      try {
        setImageLoadError(false);

        if (isTiffPath(selectedImage.path)) {
          const pngUrl = await tiffToPngDataUrl(selectedImage.url);
          if (!isCancelled) setImagePreviewUrl(pngUrl);
        } else {
          if (!isCancelled) setImagePreviewUrl(selectedImage.url);
        }

        // try to load mask overlays (mask and instance) if available
        try {
          setMaskOverlayUrl(null);
          setInstanceOverlayUrl(null);

          const { maskUrl, instanceUrl } = findOverlayUrls(selectedImage.path, masks);

          if (maskUrl) {
            const overlay = await fetchAndColorizeMask(maskUrl);
            if (!isCancelled) setMaskOverlayUrl(overlay);
          }

          if (instanceUrl) {
            const ov = await fetchAndColorizeMask(instanceUrl, true);
            if (!isCancelled) setInstanceOverlayUrl(ov);
          }
        } catch (err) {
          console.warn("Failed to load mask overlays:", err);
        }
      } catch (error) {
        console.error("Failed to render image preview:", error);

        if (!isCancelled) {
          setImageLoadError(true);
          setImagePreviewUrl(null);
        }
      }
    };

    void loadPreview();

    return () => {
      isCancelled = true;
    };
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

    if (filterMode === "all") {
      return baseImages;
    }

    return baseImages.filter((image) => {
      const isAnnotated = annotatedSet.has(image.path);
      return filterMode === "annotated" ? isAnnotated : !isAnnotated;
    });
  }, [images, selectedFolderPath, filterMode, annotatedSet]);

  const selectedImageIndex = useMemo(() => {
    if (!selectedImage) {
      return -1;
    }

    return visibleImages.findIndex(
      (image) => image.path === selectedImage.path
    );
  }, [selectedImage, visibleImages]);

  const connectToContainer = async () => {
    const trimmedSasUrl = sasUrl.trim();

    if (!trimmedSasUrl) {
      setStatus("Please enter a SAS URL.");
      return;
    }

    try {
      setIsLoading(true);
      setStatus("Loading images...");
      setTree(null);
      setImages([]);
      setSelectedImage(null);
      setSelectedFolderPath(null);
      setImagePreviewUrl(null);
      setImageLoadError(false);
      setExpandedFolders(new Set());
      setMaskOverlayUrl(null);
      setInstanceOverlayUrl(null);

      const loadedImages =
        (await loadImages(trimmedSasUrl)) as DatasetImage[];

      const validImages = loadedImages.filter(
        (image) =>
          typeof image.path === "string" &&
          typeof image.url === "string" &&
          !image.name.toLowerCase().includes("frameproperties")
      );


      const builtTree = buildTree(
        validImages.map((image) => image.path)
      );

      const rootFolder = getPreferredRootFolder(validImages);

      const loadedMasks = await loadMasks(trimmedSasUrl);
      const maskMap: Record<string, string> = {};
      for (const m of loadedMasks) {
        maskMap[m.path] = m.url;
      }

      const annotated = new Set<string>();
      const maskPathsByName = new Map<string, string[]>();
      for (const m of loadedMasks) {
        const name = m.name;
        const base = name.replace(/(_mask|_instance)?\.png$/i, "");
        const arr = maskPathsByName.get(base) ?? [];
        arr.push(m.path);
        maskPathsByName.set(base, arr);
      }

      for (const img of validImages) {
        const expected = getMaskPathFromImagePath(img.path);
        if (expected && maskMap[expected]) {
          annotated.add(img.path);
          continue;
        }

        const base = getBaseName(img.path);
        const candidates = maskPathsByName.get(base) ?? [];
        if (candidates.length > 0) {
          annotated.add(img.path);
        }
      }

      setMasks(maskMap);
      setAnnotatedSet(annotated);

      const annotatedTree = computeAnnotatedCounts(builtTree, annotated);

      setImages(validImages);
      setTree(annotatedTree);
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

        setSelectedImage(firstImageInRoot);
        setStatus(
          rootFolder
            ? `Connected successfully. Showing ${rootFolder} images.`
            : `Connected successfully. Found ${validImages.length} images.`
        );
      } else {
        setStatus(
          "Connected successfully, but no supported images were found."
        );
      }
    } catch (error: unknown) {
      console.error("Failed to connect to Azure Blob Storage:", error);

      setImages([]);
      setTree(null);
      setSelectedImage(null);
      setSelectedFolderPath(null);
      setImagePreviewUrl(null);
      setExpandedFolders(new Set());
      setMasks({});
      setAnnotatedSet(new Set());

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
      ? images.filter((image) => {
          return (
            image.path === folderPath ||
            image.path.startsWith(`${folderPath}/`)
          );
        })
      : images;

    const filteredFolderImages =
      filterMode === "all"
        ? folderImages
        : folderImages.filter((image) => {
            const isAnnotated = annotatedSet.has(image.path);
            return filterMode === "annotated" ? isAnnotated : !isAnnotated;
          });

    if (filteredFolderImages.length > 0) {
      setSelectedImage(filteredFolderImages[0]);
      setImageLoadError(false);
      setStatus(
        folderPath
          ? `Showing ${filteredFolderImages.length} image${
              filteredFolderImages.length === 1 ? "" : "s"
            } in ${folderPath}.`
          : `Showing all ${filteredFolderImages.length} images.`
      );
      return;
    }

    setSelectedImage(null);
    setImageLoadError(false);
    setStatus(
      folderPath ? `No images found in ${folderPath}.` : "No images found."
    );
  };

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);

      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }

      return next;
    });

    setTimeout(() => {
      if (!selectedImage) return;
      const el = document.getElementById(
        `file-${encodeURIComponent(selectedImage.path)}`
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 60);
  };

  const handleImageSelected = (path: string) => {
    const image = images.find((candidate) => candidate.path === path);

    if (!image) {
      setStatus(`Could not find image: ${path}`);
      return;
    }

    setSelectedFolderPath(getParentFolderPath(path));
    setImageLoadError(false);
    setSelectedImage(image);
  };

  const selectPreviousImage = () => {
    if (selectedImageIndex <= 0) {
      return;
    }

    setImageLoadError(false);
    setSelectedImage(visibleImages[selectedImageIndex - 1]);
  };

  const selectNextImage = () => {
    if (
      selectedImageIndex < 0 ||
      selectedImageIndex >= visibleImages.length - 1
    ) {
      return;
    }

    setImageLoadError(false);
    setSelectedImage(visibleImages[selectedImageIndex + 1]);
  };

  const handleSasUrlKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Enter" && !isLoading) {
      void connectToContainer();
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily:
          '"Segoe UI", system-ui, -apple-system, sans-serif',
        color: "#242424",
        background: "#ffffff",
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
            background:
              isLoading || sasUrl.trim().length === 0
                ? "#a0a0a0"
                : "#0067b8",
            color: "#ffffff",
            fontWeight: 600,
            cursor:
              isLoading || sasUrl.trim().length === 0
                ? "not-allowed"
                : "pointer",
          }}
        >
          {isLoading ? "Connecting..." : "Connect"}
        </button>
      </header>

      <div
        role="status"
        aria-live="polite"
        style={{
          padding: "8px 16px",
          background: "#f5f5f5",
          borderBottom: "1px solid #dddddd",
          fontSize: "14px",
        }}
      >
        {status}
      </div>

      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid #dddddd",
          fontSize: "14px",
          fontWeight: 600,
        }}
      >
        Images: {visibleImages.length}
      </div>

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "minmax(280px, 250px) 1fr minmax(220px, 250px)",
          overflow: "hidden",
        }}
      >
        <aside
          style={{
            minWidth: 0,
            padding: "12px",
            overflow: "auto",
            borderRight: "1px solid #dddddd",
          }}
        >
          <h2
            style={{
              margin: "0 0 12px",
              fontSize: "18px",
            }}
          >
            Folder Tree
          </h2>

          {isLoading ? (
            <p>Loading dataset...</p>
          ) : tree ? (
            <FolderTree
              node={tree}
              selectedFolderPath={selectedFolderPath}
              selectedImagePath={selectedImage?.path ?? null}
              expandedFolders={expandedFolders}
              annotatedSet={annotatedSet}
              filterMode={filterMode}
              onFolderSelected={handleFolderSelected}
              onToggleFolder={handleToggleFolder}
              onImageSelected={handleImageSelected}
            />
          ) : (
            <p style={{ color: "#666666" }}>
              No dataset loaded.
            </p>
          )}
        </aside>

        <section
          style={{
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: "#f8f8f8",
          }}
        >
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
                  Check that the SAS token has read permission and has
                  not expired.
                </div>
              ) : (
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <img
                    key={`${selectedImage.path}-base`}
                    src={imagePreviewUrl ?? selectedImage.url}
                    alt={selectedImage.name || getFileName(selectedImage.path)}
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      boxShadow: "0 2px 12px rgba(0, 0, 0, 0.12)",
                      background: "#ffffff",
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
              )
            ) : (
              <p style={{ color: "#666666" }}>
                Select an image from the folder tree.
              </p>
            )}
          </div>

          <div
            style={{
              minHeight: "52px",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: "12px",
              padding: "8px 16px",
              borderTop: "1px solid #dddddd",
              background: "#ffffff",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginRight: 8 }}>
              <label style={{ fontSize: 12, color: "#444" }}>
                <input
                  type="checkbox"
                  checked={showMaskOverlay}
                  onChange={(e) => setShowMaskOverlay(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Show mask
              </label>

              <label style={{ fontSize: 12, color: "#444" }}>
                <input
                  type="checkbox"
                  checked={showInstanceOverlay}
                  onChange={(e) => setShowInstanceOverlay(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Show instances
              </label>
            </div>

            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {(["all", "annotated", "unannotated"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFilterMode(mode)}
                  style={{
                    border: filterMode === mode ? "1px solid #0b57d0" : "1px solid #d1d5db",
                    background: filterMode === mode ? "#edf4ff" : "#ffffff",
                    color: filterMode === mode ? "#0b57d0" : "#374151",
                    borderRadius: 6,
                    padding: "6px 10px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {mode === "all" ? "All" : mode === "annotated" ? "Annotated" : "Unannotated"}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={selectPreviousImage}
              disabled={selectedImageIndex <= 0}
              style={navigationButtonStyle(
                selectedImageIndex <= 0
              )}
            >
              Previous
            </button>

            <span
              style={{
                minWidth: "90px",
                textAlign: "center",
                fontSize: "14px",
              }}
            >
              {selectedImageIndex >= 0
                ? `${selectedImageIndex + 1} / ${visibleImages.length}`
                : `0 / ${visibleImages.length}`}
            </span>

            <button
              type="button"
              onClick={selectNextImage}
              disabled={
                selectedImageIndex < 0 ||
                selectedImageIndex >= visibleImages.length - 1
              }
              style={navigationButtonStyle(
                selectedImageIndex < 0 ||
                  selectedImageIndex >= visibleImages.length - 1
              )}
            >
              Next
            </button>
          </div>
        </section>

        <aside
          style={{
            minWidth: 0,
            padding: "16px",
            overflow: "auto",
            borderLeft: "1px solid #dddddd",
          }}
        >
          <h2
            style={{
              margin: "0 0 16px",
              fontSize: "18px",
            }}
          >
            Image Information
          </h2>

          {selectedImage ? (
            <dl style={{ margin: 0 }}>
              <dt style={labelStyle}>File</dt>
              <dd style={valueStyle}>
                {selectedImage.name ||
                  getFileName(selectedImage.path)}
              </dd>

              <dt style={labelStyle}>Path</dt>
              <dd
                style={{
                  ...valueStyle,
                  overflowWrap: "anywhere",
                }}
              >
                {selectedImage.path}
              </dd>

              <dt style={labelStyle}>Position</dt>
              <dd style={valueStyle}>
                {selectedImageIndex + 1} / {visibleImages.length}
              </dd>

              <dt style={labelStyle}>Image URL</dt>
              <dd style={valueStyle}>
                <a
                  href={selectedImage.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open image in new tab
                </a>
              </dd>
            </dl>
          ) : (
            <p style={{ color: "#666666" }}>
              No image selected.
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function getParentFolderPath(path: string): string | null {
  const normalized = path.trim();
  if (!normalized) {
    return null;
  }

  const fragments = normalized.split("/");
  if (fragments.length <= 1) {
    return null;
  }

  fragments.pop();
  return fragments.join("/");
}

function isTiffPath(path: string): boolean {
  return /\.(tif|tiff)$/i.test(path);
}

async function tiffToPngDataUrl(tiffUrl: string): Promise<string> {
  const response = await fetch(tiffUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch TIFF image: ${response.statusText}`);
  }

  const tiffBuffer = await response.arrayBuffer();
  const ifd = UTIF.decode(tiffBuffer);

  if (!ifd || ifd.length === 0) {
    throw new Error("TIFF could not be decoded.");
  }

  const firstImage = ifd[0];
  UTIF.decodeImage(tiffBuffer, firstImage);

  const rgba = UTIF.toRGBA8(firstImage);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas is not supported in this browser.");
  }

  canvas.width = firstImage.width;
  canvas.height = firstImage.height;

  const imageData = new ImageData(
    new Uint8ClampedArray(rgba),
    firstImage.width,
    firstImage.height
  );

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function fetchAndColorizeMask(maskUrl: string, isInstance = false): Promise<string> {
  const res = await fetch(maskUrl);
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

  const sampleValues: number[] = [];
  for (let i = 0; i < Math.min(data.length, 80); i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const value = Math.max(r, g, b);
    if (value > 0) {
      sampleValues.push(value);
    }
  }

  const labelSet = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const value = Math.max(r, g, b);
    if (value > 0) {
      labelSet.add(value);
    }
  }

  const colors: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 128, 255],
    [255, 165, 0],
    [200, 0, 200],
    [0, 200, 100],
  ];

  const labelToColor = new Map<number, [number, number, number]>();
  let idx = 0;
  for (const label of Array.from(labelSet)) {
    labelToColor.set(label, colors[idx % colors.length]);
    idx++;
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

    const color =
      labelToColor.get(label) ?? ([255, 0, 255] as [number, number, number]);
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

  return outCanvas.toDataURL("image/png");
}

function getExpandedFolderSet(node: TreeNode): Set<string> {
  const expanded = new Set<string>();

  const visit = (current: TreeNode) => {
    if (current.path && current.children.length > 0) {
      expanded.add(current.path);
    }

    current.children.forEach(visit);
  };

  visit(node);
  return expanded;
}

function navigationButtonStyle(
  disabled: boolean
): React.CSSProperties {
  return {
    padding: "8px 14px",
    border: "1px solid #b3b3b3",
    borderRadius: "4px",
    background: disabled ? "#eeeeee" : "#ffffff",
    color: disabled ? "#888888" : "#242424",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const labelStyle: React.CSSProperties = {
  marginTop: "16px",
  marginBottom: "4px",
  fontWeight: 700,
};

const valueStyle: React.CSSProperties = {
  margin: 0,
  color: "#555555",
};

function getPreferredRootFolder(images: DatasetImage[]): string | null {
  const rawFolder = images.find((image) =>
    image.path.split("/").some((segment) => segment.toLowerCase() === "raw")
  );

  if (!rawFolder) {
    return null;
  }

  const segments = rawFolder.path.split("/");
  const rawIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === "raw"
  );

  if (rawIndex === -1) {
    return null;
  }

  return segments.slice(0, rawIndex + 1).join("/");
}

function getBaseName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.[^.]+$/, "");
}

function getMaskPathFromImagePath(imagePath: string): string | null {
  const segments = imagePath.split("/");
  const rawIndex = segments.findIndex((s) => s.toLowerCase() === "raw");

  const filename = segments[segments.length - 1];
  const base = filename.replace(/\.[^.]+$/, "");

  if (rawIndex !== -1) {
    const maskSegments = [...segments];
    maskSegments[rawIndex] = "masks";
    maskSegments[maskSegments.length - 1] = `${base}_mask.png`;
    return maskSegments.join("/");
  }

  return null;
}

function computeAnnotatedCounts(node: TreeNode, annotated: Set<string>): TreeNode {
  let count = 0;
  let annotatedCount = 0;

  const children = node.children.map((child) => {
    const childNode = computeAnnotatedCounts(child, annotated);
    count += childNode.count;
    annotatedCount += childNode.annotatedCount ?? 0;
    return childNode;
  });

  count += node.images.length;
  for (const img of node.images) {
    const fullPath = node.path === "" ? img : `${node.path}/${img}`;
    if (annotated.has(fullPath)) annotatedCount++;
  }

  return {
    ...node,
    children,
    count,
    annotatedCount,
  };
}

function findOverlayUrls(
  imagePath: string,
  masks: Record<string, string>
): { maskUrl?: string; instanceUrl?: string } {
  const base = getBaseName(imagePath).toLowerCase();
  let maskUrl: string | undefined;
  let instanceUrl: string | undefined;

  for (const [path, url] of Object.entries(masks)) {
    const lower = path.toLowerCase();
    if (!maskUrl && lower.includes(`${base}_mask`)) {
      maskUrl = url;
    }
    if (!instanceUrl && lower.includes(`${base}_instance`)) {
      instanceUrl = url;
    }
    if (maskUrl && instanceUrl) {
      break;
    }
  }

  if (!maskUrl) {
    const expected = getMaskPathFromImagePath(imagePath);
    if (expected) {
      maskUrl = masks[expected];
    }
  }

  if (!instanceUrl) {
    for (const [path, url] of Object.entries(masks)) {
      const lower = path.toLowerCase();
      if (lower.includes(base) && lower.includes("_instance")) {
        instanceUrl = url;
        break;
      }
    }
  }

  return { maskUrl, instanceUrl };
}