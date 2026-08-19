import { ContainerClient } from "@azure/storage-blob";

export interface ImageBlob {
  name: string;
  path: string;
  url: string;
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