import { ContainerClient } from "@azure/storage-blob";

export interface ImageBlob {
  name: string;
  path: string;
  url: string;
}

export type NoteValue =
  | string
  | {
      question?: string;
      note?: string;
      comment?: string;
      answer?: string;
      reply?: string;
      answered?: boolean;
      comments?: string[] | string;
    };

export interface InclusionDictionaryEntry {
  id: number;
  name: string;
}

function shouldIncludeBlob(blobName: string): boolean {
  const segments = blobName
    .split("/")
    .map((segment) => segment.toLowerCase());

  if (segments.includes("masks")) {
    return false;
  }

  const name = blobName.toLowerCase();

  return (
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".png") ||
    name.endsWith(".bmp") ||
    name.endsWith(".gif") ||
    name.endsWith(".webp") ||
    name.endsWith(".tif") ||
    name.endsWith(".tiff") ||
    name.endsWith(".heic")
  );
}

export async function loadImages(
  sasUrl: string
): Promise<ImageBlob[]> {
  const client = new ContainerClient(sasUrl.trim());

  const images: ImageBlob[] = [];

  for await (const blob of client.listBlobsFlat()) {
    if (!shouldIncludeBlob(blob.name)) {
      continue;
    }

    const blobClient = client.getBlobClient(blob.name);

    images.push({
      name: blob.name.split("/").pop() ?? "",
      path: blob.name,
      url: blobClient.url,
    });
  }

  return images.sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadMasks(
  sasUrl: string
): Promise<ImageBlob[]> {
  const client = new ContainerClient(sasUrl.trim());

  const masks: ImageBlob[] = [];

  for await (const blob of client.listBlobsFlat()) {
    const name = blob.name.toLowerCase();

    // only consider mask PNGs (mask and instance maps)
    if (!name.includes("masks") || !name.endsWith(".png")) {
      continue;
    }

    const blobClient = client.getBlobClient(blob.name);

    masks.push({
      name: blob.name.split("/").pop() ?? "",
      path: blob.name,
      url: blobClient.url,
    });
  }

  return masks.sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadNotes(
  sasUrl: string
): Promise<Record<string, NoteValue>> {
  const client = new ContainerClient(sasUrl.trim());

  try {
    const blobClient = client.getBlobClient("metadata/notes.json");
    const response = await fetch(blobClient.url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }

    return data as Record<string, NoteValue>;
  } catch (error) {
    console.warn("Could not load metadata/notes.json", error);
    return {};
  }
}

export async function saveNotes(
  sasUrl: string,
  notes: Record<string, NoteValue>
): Promise<void> {
  const client = new ContainerClient(sasUrl.trim());
  const blobClient = client.getBlockBlobClient("metadata/notes.json");
  const json = JSON.stringify(notes, null, 2);
  const encoded = new TextEncoder().encode(json);

  await blobClient.uploadData(encoded, {
    blobHTTPHeaders: {
      blobContentType: "application/json",
    },
  });
}

export async function loadInclusionDictionary(
  sasUrl: string
): Promise<InclusionDictionaryEntry[]> {
  const client = new ContainerClient(sasUrl.trim());

  try {
    const blobClient = client.getBlobClient("metadata/inclusion_dictionary.json");
    const response = await fetch(blobClient.url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter(
        (item): item is InclusionDictionaryEntry =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "number" &&
          typeof (item as { name?: unknown }).name === "string"
      )
      .map((item) => ({
        id: item.id,
        name: item.name.trim() || `ID ${item.id}`,
      }))
      .sort((a, b) => a.id - b.id);
  } catch (error) {
    console.warn("Could not load metadata/inclusion_dictionary.json", error);
    return [];
  }
}