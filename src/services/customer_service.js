/**
 * Servicio de Gestión y Caché de Clientes
 * Implementa la arquitectura de almacenamiento biométrico dual:
 * - Caché ultra-rápida en memoria RAM (<1ms) para identifyFace
 * - Persistencia local transaccional en SQLite (data/barberia.db)
 * - Reflejo asíncrono a Firebase (Firestore y Storage) cuando hay cambios significativos
 */

import { sqliteClient as defaultSqliteClient, getSqliteClient } from "../infrastructure/storage/sqlite_client.js";
import { getResolvedDatabaseId } from "../infrastructure/firebase/firebase_admin.js";
import { uploadFaceCrop } from "../infrastructure/firebase/storage_client.js";

/**
 * Extrae el databaseId configurado en una instancia de Firestore si está disponible
 * @param {Object} db
 * @returns {string|null}
 */
export function extractDatabaseIdFromFirestore(db) {
  if (!db) return null;
  if (typeof db.databaseId === "string") return db.databaseId;
  if (typeof db._databaseId === "string") return db._databaseId;
  if (db._settings && typeof db._settings.databaseId === "string") return db._settings.databaseId;
  return null;
}

export class CustomerService {
  /**
   * @param {Object} [options]
   * @param {import('../infrastructure/storage/sqlite_client.js').SQLiteClient} [options.sqliteClient]
   * @param {string} [options.databaseId]
   */
  constructor(options = {}) {
    this.databaseId = options.databaseId || null;
    this.customClientProvided = Boolean(options.sqliteClient);
    this.sqliteClient = options.sqliteClient || (this.databaseId ? getSqliteClient(this.databaseId) : defaultSqliteClient);
    this.profilesCache = new Map();
    this.isLoaded = false;
  }

  /**
   * Configura o cambia la base de datos SQLite activa asociada al databaseId ('(default)', 'test', etc.)
   * @param {string} [databaseId]
   * @param {Object} [options]
   * @returns {import('../infrastructure/storage/sqlite_client.js').SQLiteClient}
   */
  initForDatabase(databaseId, options = {}) {
    const resolvedId = databaseId || getResolvedDatabaseId(options);
    this.databaseId = resolvedId;
    this.sqliteClient = options.sqliteClient || getSqliteClient(resolvedId, options);
    this.customClientProvided = Boolean(options.sqliteClient);
    this.clearMemoryCache();
    return this.sqliteClient;
  }

  /**
   * Carga los perfiles desde SQLite en memoria RAM.
   * Si se suministra 'db', también sincroniza staff desde 'camera_catcher/staff'.
   * @param {Object} [options]
   * @param {Object} [options.db] - Instancia de Firestore (opcional)
   * @param {boolean} [options.syncWithFirestore] - Si debe forzar sincronización desde Firestore
   * @returns {Promise<Array<Object>>} Lista de perfiles cargados
   */
  async loadProfilesIntoMemory(options = {}) {
    const firestoreDbId = options.databaseId || extractDatabaseIdFromFirestore(options.db);
    if (firestoreDbId && !this.customClientProvided && firestoreDbId !== this.databaseId) {
      this.initForDatabase(firestoreDbId, options);
    }

    const profiles = this.sqliteClient.getAllComparisonProfiles();
    this.profilesCache.clear();
    for (const p of profiles) {
      this.profilesCache.set(p.id, p);
    }
    this.isLoaded = true;

    // Si SQLite está vacío o se pide sincronización y se proporcionó Firestore db:
    if (options.db && (profiles.length === 0 || options.syncWithFirestore)) {
      await this.loadProfilesFromFirestore(options.db);
    }

    // Sincronizar staff desde Firestore si está disponible
    if (options.db && typeof options.db.doc === "function") {
      try {
        const staffDoc = await options.db.doc("camera_catcher/staff").get();
        if (staffDoc && staffDoc.exists) {
          const members = staffDoc.data()?.members || [];
          for (const staff of members) {
            const staffId = staff.id || `staff_${staff.name}`;
            const staffProfile = {
              id: staffId,
              name: staff.name || "Staff",
              isStaff: true,
              role: staff.role || "barber",
              embedding: staff.embedding,
              embeddings: staff.embeddings || (staff.embedding ? [staff.embedding] : []),
              photos: staff.photos || [],
              thumbnailBase64: staff.thumbnailBase64 || null,
              bestFaceScore: staff.bestFaceScore || 0
            };
            this.sqliteClient.upsertCustomer(staffProfile);
            this.profilesCache.set(staffId, staffProfile);
          }
        }
      } catch (err) {
        console.warn(`[CustomerService] Aviso al sincronizar staff desde Firestore:`, err.message);
      }
    }

    return this.getComparisonProfiles();
  }

  /**
   * Carga perfiles desde Firestore hacia SQLite y memoria RAM.
   * (Útil para bootstrapping inicial o pruebas unitarias).
   * @param {Object} db - Instancia de Firestore
   * @returns {Promise<Array<Object>>}
   */
  async loadProfilesFromFirestore(db) {
    if (!db || typeof db.collection !== "function") return [];
    const firestoreDbId = extractDatabaseIdFromFirestore(db);
    if (firestoreDbId && !this.customClientProvided && firestoreDbId !== this.databaseId) {
      this.initForDatabase(firestoreDbId);
    }
    try {
      const snap = await db.collection("camera_catcher_people").get();
      const loaded = [];
      const iterateDocs = (fn) => {
        if (typeof snap.forEach === "function") {
          snap.forEach(fn);
        } else if (Array.isArray(snap)) {
          snap.forEach(fn);
        } else if (Array.isArray(snap.docs)) {
          snap.docs.forEach(fn);
        }
      };

      iterateDocs(docSnap => {
        const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
        const id = docSnap.id || data.id;
        if (id) {
          const profile = { id, ...data };
          this.sqliteClient.upsertCustomer(profile);
          this.profilesCache.set(id, profile);
          loaded.push(profile);
        }
      });

      this.isLoaded = true;
      return loaded;
    } catch (err) {
      console.warn(`[CustomerService] Error cargando perfiles desde Firestore:`, err.message);
      return [];
    }
  }

  /**
   * Entrega en <1ms los perfiles activos para identifyFace sin consultar Firestore ni disco en cada frame.
   * @returns {Array<Object>}
   */
  getComparisonProfiles() {
    if (!this.isLoaded) {
      const profiles = this.sqliteClient.getAllComparisonProfiles();
      this.profilesCache.clear();
      for (const p of profiles) {
        this.profilesCache.set(p.id, p);
      }
      this.isLoaded = true;
    }
    return Array.from(this.profilesCache.values());
  }

  /**
   * Obtiene los datos completos de un cliente por su ID (desde RAM o SQLite)
   * @param {string} id
   * @returns {Object|null}
   */
  getCustomerData(id) {
    if (this.profilesCache.has(id)) {
      return this.profilesCache.get(id);
    }
    const customer = this.sqliteClient.getCustomerById(id);
    if (customer) {
      this.profilesCache.set(id, customer);
    }
    return customer;
  }

  /**
   * Comprueba si un perfil ya está cargado en memoria
   * @param {string} id
   * @returns {boolean}
   */
  hasProfile(id) {
    return this.profilesCache.has(id);
  }

  /**
   * Limpia la caché en RAM (útil entre pruebas)
   */
  clearMemoryCache() {
    this.profilesCache.clear();
    this.isLoaded = false;
  }

  /**
   * Limpia tanto la caché en RAM como los datos en SQLite (útil entre pruebas)
   */
  reset() {
    this.clearMemoryCache();
    if (this.sqliteClient && typeof this.sqliteClient.clearAll === "function") {
      this.sqliteClient.clearAll();
    }
  }

  /**
   * Guarda o actualiza un cliente:
   * 1. Actualiza SQLite localmente
   * 2. Actualiza la caché en RAM localmente (<1ms)
   * 3. De forma asíncrona refleja a Firebase (Firestore y Storage) cuando:
   *    - Es cliente nuevo (options.isNew === true)
   *    - Mayor nitidez (options.higherSharpness === true o sharpnessScore > bestFaceScore)
   *    - Ángulo novedoso añadido a la galería (options.newAngle === true o options.galleryUpdated === true)
   *    - Sincronización explícita solicitada (options.forceSync === true)
   *
   * @param {Object} customerData
   * @param {Object} [options]
   * @param {Object} [options.db] - Instancia de Firestore
   * @param {Object} [options.bucket] - Bucket de Firebase Storage
   * @param {Buffer} [options.faceBuffer] - Buffer binario de recorte de rostro nítido
   * @param {boolean} [options.isNew] - Indica si es un cliente recién registrado
   * @param {boolean} [options.newAngle] - Indica si se agregó un nuevo ángulo a la galería
   * @param {boolean} [options.higherSharpness] - Indica si se superó la nitidez previa
   * @param {boolean} [options.galleryUpdated] - Indica si la galería o fotos fueron actualizadas
   * @param {boolean} [options.forceSync] - Fuerza la sincronización hacia Firestore
   * @param {boolean} [options.backgroundSync] - Si true, no espera la promesa de sincronización en red
   * @returns {Promise<Object>}
   */
  async saveOrUpdateCustomer(customerData, options = {}) {
    if (!customerData || !customerData.id) {
      throw new Error("El cliente debe contener al menos un id válido.");
    }

    const firestoreDbId = options.databaseId || extractDatabaseIdFromFirestore(options.db);
    if (firestoreDbId && !this.customClientProvided && firestoreDbId !== this.databaseId) {
      this.initForDatabase(firestoreDbId, options);
    }

    // 1. Persistir en SQLite local
    this.sqliteClient.upsertCustomer(customerData);

    // 2. Actualizar caché en memoria RAM inmediatamente
    const current = this.profilesCache.get(customerData.id) || {};
    const updated = { ...current, ...customerData };
    this.profilesCache.set(customerData.id, updated);

    // 3. Determinar si requiere reflejo a Firebase
    const shouldReflectToFirebase = Boolean(
      options.db && (
        options.isNew ||
        options.newAngle ||
        options.higherSharpness ||
        options.galleryUpdated ||
        options.forceSync ||
        (options.sharpnessScore && options.sharpnessScore > (current.bestFaceScore || 0))
      )
    );

    if (shouldReflectToFirebase) {
      const syncPromise = this._syncToFirebase(updated, options).catch(err => {
        console.warn(`[CustomerService] Error sincronizando a Firebase para "${updated.name}" (${updated.id}):`, err.message);
      });

      if (options.backgroundSync) {
        return { id: updated.id, localSaved: true, queuedSync: true };
      }

      await syncPromise;
      return { id: updated.id, localSaved: true, synced: true };
    }

    return { id: updated.id, localSaved: true, synced: false };
  }

  /**
   * Refleja de forma asíncrona un cliente a Firebase (Firestore y Storage)
   * @private
   */
  async _syncToFirebase(customer, options) {
    const { db, bucket, faceBuffer, isNew } = options;
    if (!db) return;

    // Si hay un recorte de rostro nítido de alta calidad y bucket disponible, subirlo a Storage
    let uploadedThumbnailPath = customer.thumbnailPath || null;
    if (bucket && faceBuffer) {
      try {
        const storagePath = `camera_catcher/faces/${customer.id}_${Date.now()}.jpg`;
        await uploadFaceCrop(bucket, storagePath, faceBuffer);
        uploadedThumbnailPath = storagePath;
        customer.thumbnailPath = uploadedThumbnailPath;
        this.sqliteClient.upsertCustomer({ id: customer.id, thumbnailPath: uploadedThumbnailPath });
      } catch (uploadErr) {
        console.warn(`[CustomerService] Fallo opcional al subir recorte facial a Storage:`, uploadErr.message);
      }
    }

    // Preparar objeto para Firestore removiendo campos binarios no serializables
    const firestoreData = {
      id: customer.id,
      name: customer.name || "Cliente",
      isStaff: customer.isStaff === true,
      role: customer.role || (customer.isStaff ? "barber" : "client"),
      firstSeen: customer.firstSeen || new Date().toISOString(),
      lastSeen: customer.lastSeen || new Date().toISOString(),
      visitCount: customer.visitCount || 1,
      bestFaceScore: Number(customer.bestFaceScore || 0),
      thumbnailBase64: customer.thumbnailBase64 || null,
      thumbnailPath: uploadedThumbnailPath || customer.thumbnailPath || "",
      photos: Array.isArray(customer.photos) ? customer.photos : []
    };

    if (Array.isArray(customer.embeddings) && customer.embeddings.length > 0) {
      firestoreData.embeddings = customer.embeddings;
    }
    if (Array.isArray(customer.embedding)) {
      firestoreData.embedding = customer.embedding;
    }

    const docRef = db.doc(`camera_catcher_people/${customer.id}`);
    if (isNew) {
      await docRef.set(firestoreData);
      console.log(`[CustomerService] ✅ Nuevo cliente sincronizado con Firestore: "${customer.name}" (${customer.id})`);
    } else {
      await docRef.set(firestoreData, { merge: true });
      console.log(`[CustomerService] 🔄 Cliente actualizado en Firestore: "${customer.name}" (${customer.id})`);
    }
  }

  /**
   * Elimina un cliente de SQLite, RAM y opcionalmente Firestore
   * @param {string} id
   * @param {Object} [options]
   */
  async deleteCustomer(id, options = {}) {
    const firestoreDbId = options.databaseId || extractDatabaseIdFromFirestore(options.db);
    if (firestoreDbId && !this.customClientProvided && firestoreDbId !== this.databaseId) {
      this.initForDatabase(firestoreDbId, options);
    }

    this.profilesCache.delete(id);
    this.sqliteClient.deleteCustomer(id);

    if (options.db) {
      try {
        await options.db.doc(`camera_catcher_people/${id}`).delete();
      } catch (err) {
        console.warn(`[CustomerService] Error eliminando de Firestore:`, err.message);
      }
    }
  }
}

// Instancia singleton por defecto
export const customerService = new CustomerService();
