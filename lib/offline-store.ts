import type { YouTubeVideo } from "./types";

const DB_NAME = "sonora-offline";
const DB_VERSION = 1;
const STORE_NAME = "tracks";

export type OfflineTrack = YouTubeVideo & {
  audio: Blob;
  audioType: string;
  bytes: number;
  savedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open offline storage."));
  });
}

export async function listOfflineTracks(): Promise<OfflineTrack[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as OfflineTrack[]).sort((a, b) => b.savedAt - a.savedAt));
    request.onerror = () => reject(request.error || new Error("Could not read offline tracks."));
  });
}

export async function getOfflineTrack(id: string): Promise<OfflineTrack | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as OfflineTrack | undefined);
    request.onerror = () => reject(request.error || new Error("Could not read the offline track."));
  });
}

export async function saveOfflineTrack(track: OfflineTrack): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(track);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Could not save the offline track."));
  });
}

export async function deleteOfflineTrack(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Could not delete the offline track."));
  });
}
