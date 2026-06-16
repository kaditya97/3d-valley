const DB_NAME = '3d_valley_db';
const DB_VERSION = 1;
const STORE_NAME = 'scenes';

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export const db = {
  async saveScene(scene) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(scene);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async getScene(id) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async listScenes() {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        // Map to metadata to avoid returning huge chunks of binary data when just listing
        const scenes = request.result.map((scene) => ({
          id: scene.id,
          name: scene.name,
          bbox: scene.bbox,
          createdAt: scene.createdAt || Date.now(),
          sizeEstimate: calculateEstimateSize(scene),
        }));
        resolve(scenes);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async deleteScene(id) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
};

function calculateEstimateSize(scene) {
  let bytes = 0;
  if (scene.heights) bytes += scene.heights.byteLength || 0;
  if (scene.forest) bytes += scene.forest.size || 0;
  if (scene.osm) bytes += JSON.stringify(scene.osm).length || 0;
  if (scene.textures) {
    for (const key in scene.textures) {
      if (scene.textures[key]) {
        bytes += scene.textures[key].size || 0;
      }
    }
  }
  return bytes;
}
