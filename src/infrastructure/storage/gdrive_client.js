/**
 * Cliente Google Drive API v3 nativo (Node.js fetch & streams).
 * Gestiona autenticación OAuth2 con refresh token, consulta de cuota,
 * navegación y creación de carpetas, y subida resiliente de chunks de video (Resumable Upload).
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Carga variables de .env en process.env si aún no están definidas (zero dependencies).
 */
export function loadEnvFile(envPath = null) {
  const target = envPath || path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(target)) return false;
  try {
    const content = fs.readFileSync(target, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

export class GoogleDriveClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.clientId]
   * @param {string} [options.clientSecret]
   * @param {string} [options.refreshToken]
   * @param {string} [options.rootFolderName]
   * @param {Function} [options.fetchFn] Inyección para pruebas unitarias
   */
  constructor(options = {}) {
    loadEnvFile();

    this.clientId = options.clientId || process.env.GDRIVE_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.GDRIVE_CLIENT_SECRET;
    this.refreshToken = options.refreshToken || process.env.GDRIVE_REFRESH_TOKEN;
    this.rootFolderName = options.rootFolderName || process.env.GDRIVE_RECORDINGS_FOLDER_NAME || "IOT_Camera_Recordings";
    this.fetchFn = options.fetchFn || globalThis.fetch;

    this.cachedAccessToken = null;
    this.tokenExpiresAt = 0;
    this.rootFolderId = null;
    this.dayFolderCache = new Map(); // key: `${rootId}:${dayStr}` -> folderId
  }

  /**
   * Obtiene un access_token válido usando el refresh_token.
   * Cachea el token en memoria con un margen de seguridad de 5 minutos antes de su expiración.
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    const safetyMarginMs = 5 * 60 * 1000; // 5 minutos
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt - safetyMarginMs) {
      return this.cachedAccessToken;
    }

    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error(
        "[GoogleDriveClient] Faltan credenciales de Google Drive (GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN)"
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token"
    });

    const res = await this.fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[GoogleDriveClient] Fallo al refrescar token OAuth (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error(`[GoogleDriveClient] Respuesta OAuth sin access_token: ${JSON.stringify(data)}`);
    }

    this.cachedAccessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 3600;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;

    return this.cachedAccessToken;
  }

  /**
   * Consulta la cuota de almacenamiento y datos de usuario en Google Drive.
   * @returns {Promise<{limit: number|null, usage: number, freeBytes: number|null, user: Object|null}>}
   */
  async getStorageQuota() {
    const token = await this.getAccessToken();
    const res = await this.fetchFn("https://www.googleapis.com/drive/v3/about?fields=storageQuota,user", {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[GoogleDriveClient] Error al consultar cuota (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json();
    const quota = data.storageQuota || {};
    const limit = quota.limit !== undefined ? Number(quota.limit) : null;
    const usage = quota.usage !== undefined ? Number(quota.usage) : 0;
    const freeBytes = limit !== null ? Math.max(0, limit - usage) : null;

    return {
      limit,
      usage,
      freeBytes,
      user: data.user || null
    };
  }

  /**
   * Busca una carpeta no eliminada por nombre y padre opcional.
   * @param {string} name
   * @param {string|null} [parentId]
   * @returns {Promise<{id: string, name: string}|null>}
   */
  async findFolder(name, parentId = null) {
    const token = await this.getAccessToken();
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    let q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${escapedName}'`;
    if (parentId) {
      q += ` and '${parentId}' in parents`;
    }

    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,parents,trashed)&pageSize=10`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[GoogleDriveClient] Error buscando carpeta '${name}' (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json();
    const files = data.files || [];
    if (files.length > 0) {
      return { id: files[0].id, name: files[0].name };
    }
    return null;
  }

  /**
   * Crea una carpeta en Google Drive.
   * @param {string} name
   * @param {string|null} [parentId]
   * @returns {Promise<{id: string, name: string}>}
   */
  async createFolder(name, parentId = null) {
    const token = await this.getAccessToken();
    const metadata = {
      name,
      mimeType: "application/vnd.google-apps.folder"
    };
    if (parentId) {
      metadata.parents = [parentId];
    }

    const res = await this.fetchFn("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(metadata)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[GoogleDriveClient] Error creando carpeta '${name}' (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json();
    return { id: data.id, name: data.name };
  }

  /**
   * Garantiza que la carpeta raíz exista en la raíz de Google Drive.
   * @param {string} [rootName]
   * @returns {Promise<string>} Folder ID
   */
  async ensureRootFolder(rootName = this.rootFolderName) {
    if (this.rootFolderId && rootName === this.rootFolderName) {
      return this.rootFolderId;
    }

    const existing = await this.findFolder(rootName, null);
    if (existing) {
      if (rootName === this.rootFolderName) this.rootFolderId = existing.id;
      return existing.id;
    }

    const created = await this.createFolder(rootName, null);
    if (rootName === this.rootFolderName) this.rootFolderId = created.id;
    return created.id;
  }

  /**
   * Garantiza que exista la carpeta del día (YYYY-MM-DD) dentro de rootFolderId.
   * @param {string} dayStr YYYY-MM-DD
   * @param {string|null} [rootFolderId]
   * @returns {Promise<string>} Day folder ID
   */
  async ensureDayFolder(dayStr, rootFolderId = null) {
    if (!rootFolderId) {
      rootFolderId = await this.ensureRootFolder();
    }

    const cacheKey = `${rootFolderId}:${dayStr}`;
    if (this.dayFolderCache.has(cacheKey)) {
      return this.dayFolderCache.get(cacheKey);
    }

    const existing = await this.findFolder(dayStr, rootFolderId);
    if (existing) {
      this.dayFolderCache.set(cacheKey, existing.id);
      return existing.id;
    }

    const created = await this.createFolder(dayStr, rootFolderId);
    this.dayFolderCache.set(cacheKey, created.id);
    return created.id;
  }

  /**
   * Sube un segmento de video utilizando el protocolo Resumable Upload de Google Drive API v3.
   * @param {string} filePath Ruta local del archivo .mp4
   * @param {string} [fileName] Nombre con el que se guardará en Drive
   * @param {string|null} [parentFolderId] ID de la carpeta destino en Drive
   * @returns {Promise<{fileId: string, fileName: string, size: number, md5Checksum: string|null}>}
   */
  async uploadVideoChunk(filePath, fileName = null, parentFolderId = null) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`[GoogleDriveClient] Archivo no encontrado para subida: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) {
      throw new Error(`[GoogleDriveClient] El archivo tiene tamaño 0 bytes: ${filePath}`);
    }

    const targetFileName = fileName || path.basename(filePath);
    const token = await this.getAccessToken();

    // 1. Iniciar sesión de Resumable Upload
    const initHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(fileSize)
    };

    const metadata = {
      name: targetFileName
    };
    if (parentFolderId) {
      metadata.parents = [parentFolderId];
    }

    const initRes = await this.fetchFn("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify(metadata)
    });

    if (!initRes.ok) {
      const errText = await initRes.text();
      throw new Error(`[GoogleDriveClient] Fallo al iniciar resumable upload (HTTP ${initRes.status}): ${errText}`);
    }

    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) {
      throw new Error("[GoogleDriveClient] Google Drive no devolvió cabecera 'Location' para la subida");
    }

    // 2. Subir stream de video hacia uploadUrl
    const fileStream = fs.createReadStream(filePath);
    const putRes = await this.fetchFn(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": "video/mp4"
      },
      body: fileStream,
      duplex: "half"
    });

    if (putRes.status !== 200 && putRes.status !== 201) {
      const errText = await putRes.text();
      throw new Error(`[GoogleDriveClient] Error en PUT de video (HTTP ${putRes.status}): ${errText}`);
    }

    const data = await putRes.json();
    return {
      fileId: data.id,
      fileName: data.name || targetFileName,
      size: data.size !== undefined ? Number(data.size) : fileSize,
      md5Checksum: data.md5Checksum || null
    };
  }
}
