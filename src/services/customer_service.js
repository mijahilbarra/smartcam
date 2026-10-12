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
    this.db = options.db || null;
    this.customClientProvided = Boolean(options.sqliteClient);
    this.sqliteClient = options.sqliteClient || (this.databaseId ? getSqliteClient(this.databaseId) : defaultSqliteClient);
    this.profilesCache = new Map();
    this.pendingSyncs = new Set();
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
    if (options.db) this.db = options.db;
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

    // Sincronizar staff desde Firestore si está disponible (camera_catcher_people o documento legacy)
    if (options.db) {
      try {
        if (typeof options.db.collection === "function") {
          try {
            const col = options.db.collection("camera_catcher_people");
            if (typeof col?.where === "function") {
              const staffSnap = await col.where("isStaff", "==", true).get();
              if (staffSnap && !staffSnap.empty) {
                staffSnap.forEach(docSnap => {
                  const data = docSnap.data();
                  const staffId = docSnap.id;
                  const isClientName = /^Cliente #\d+$/i.test(data.name?.trim() || "");
                  if (isClientName) return;
                  const staffProfile = {
                    id: staffId,
                    name: data.name || "Barbero",
                    isStaff: true,
                    role: data.role || "barber",
                    embedding: data.embedding || (data.embeddings?.[0] ? (Array.isArray(data.embeddings[0]) ? data.embeddings[0] : data.embeddings[0].vector) : null),
                    embeddings: data.embeddings || (data.embedding ? [data.embedding] : []),
                    photos: data.photos || [],
                    thumbnailBase64: data.thumbnailBase64 || null,
                    bestFaceScore: data.bestFaceScore || 0
                  };
                  this.sqliteClient.upsertCustomer(staffProfile);
                  this.profilesCache.set(staffId, staffProfile);
                });
              }
            }
          } catch (_) {}
        }
        if (typeof options.db.doc === "function") {
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
                photos: [],
                thumbnailBase64: null,
                bestFaceScore: staff.bestFaceScore || 0
              };
              this.sqliteClient.upsertCustomer(staffProfile);
              this.profilesCache.set(staffId, staffProfile);
            }
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
          const isClientName = /^Cliente #\d+$/i.test(data.name?.trim() || "");
          const isClientExplicit = isClientName || data.role === "client" || data.isStaff === false;
          const isStaff = !isClientExplicit && (data.isStaff === true || data.role === "barber" || String(id).startsWith("staff_"));
          const status = data.status || ((data.visitCount || 0) > 1 ? "frequent" : "new");
          const profile = {
            id,
            ...data,
            status,
            isStaff,
            role: isStaff ? (data.role || "barber") : "client"
          };
          this.sqliteClient.upsertCustomer(profile);
          const cachedForComparison = { ...profile, photos: [], thumbnailBase64: null };
          this.profilesCache.set(id, cachedForComparison);
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
   * Registra un listener en tiempo real a 'camera_catcher_people' para sincronizar
   * inmediatamente cualquier cambio de rol (ej: Barbero <-> Cliente), nombre o eliminación
   * realizado por el usuario desde la interfaz web hacia SQLite y la memoria RAM.
   * @param {Object} db - Instancia de Firestore
   */
  setupPeopleListener(db) {
    if (!db || typeof db.collection !== "function") return;
    if (this._peopleUnsubscribe) {
      try { this._peopleUnsubscribe(); } catch (_) {}
    }
    console.log(`[CustomerService] 👂 Escuchando cambios en 'camera_catcher_people' en tiempo real...`);
    try {
      this._peopleUnsubscribe = db.collection("camera_catcher_people").onSnapshot((snapshot) => {
        if (!snapshot || typeof snapshot.docChanges !== "function") return;
        snapshot.docChanges().forEach((change) => {
          const docData = change.doc.data();
          const id = change.doc.id;
          if (change.type === "removed") {
            this.profilesCache.delete(id);
            this.sqliteClient.deleteCustomer(id);
            console.log(`[CustomerService] 🗑️ Perfil "${docData?.name || id}" eliminado en tiempo real desde Firestore.`);
          } else {
            // added o modified
            const isClientName = /^Cliente #\d+$/i.test(docData?.name?.trim() || "");
            const isClientExplicit = isClientName || docData?.role === "client" || docData?.isStaff === false;
            const isStaff = !isClientExplicit && ((docData?.isStaff === true && docData?.role === "barber") || (String(id).startsWith("staff_") && docData?.isStaff !== false && docData?.role !== "client"));
            const role = isStaff ? "barber" : "client";
            const visitCount = docData?.visitCount || 1;
            const status = docData?.status || (visitCount > 1 ? "frequent" : "new");
            const profile = {
              id,
              name: docData?.name || "Cliente",
              isStaff,
              role,
              status,
              embedding: docData?.embedding || (docData?.embeddings?.[0] ? (Array.isArray(docData.embeddings[0]) ? docData.embeddings[0] : docData.embeddings[0].vector) : null),
              embeddings: docData?.embeddings || (docData?.embedding ? [docData.embedding] : []),
              photos: docData?.photos || [],
              thumbnailBase64: docData?.thumbnailBase64 || null,
              bestFaceScore: docData?.bestFaceScore || 0,
              visitCount,
              appointmentCount: docData?.appointmentCount || docData?.visitCount || 1
            };
            this.sqliteClient.upsertCustomer(profile);
            const cached = { ...profile, photos: [], thumbnailBase64: null };
            this.profilesCache.set(id, cached);
            console.log(`[CustomerService] 🔄 Perfil sincronizado en tiempo real desde Firestore: "${profile.name}" (${id}, rol: ${role}, isStaff: ${isStaff})`);
          }
        });
      }, (err) => {
        console.warn(`[CustomerService] Error en listener de 'camera_catcher_people':`, err.message);
      });
    } catch (err) {
      console.warn(`[CustomerService] Fallo al suscribir listener de camera_catcher_people:`, err.message);
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
    let customer = null;
    if (this.sqliteClient) {
      customer = this.sqliteClient.getCustomerById(id);
    }
    const cached = this.profilesCache.get(id);
    if (!customer) {
      return cached || null;
    }
    if (cached) {
      return {
        ...customer,
        ...cached,
        embeddings: (cached.embeddings && cached.embeddings.length > (customer.embeddings?.length || 0))
          ? cached.embeddings
          : customer.embeddings,
        photos: (cached.photos && cached.photos.length > (customer.photos?.length || 0))
          ? cached.photos
          : customer.photos
      };
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
    const current = this.profilesCache.get(customerData.id) || {};
    const visitCount = typeof customerData.visitCount === "number"
      ? customerData.visitCount
      : (typeof current.visitCount === "number" ? current.visitCount : 1);
    const resolvedStatus = customerData.status || current.status || (visitCount > 1 ? "frequent" : "new");
    const dataToSave = {
      ...customerData,
      status: resolvedStatus
    };

    // Si customerData proviene de una caché podada (photos: []) y no se solicitó explícitamente actualizar la galería,
    // preservar las fotos existentes en SQLite para evitar borrados accidentales
    if (!options.galleryUpdated && (!customerData.photos || customerData.photos.length === 0)) {
      const existingInDb = this.sqliteClient?.getCustomerById?.(customerData.id);
      if (existingInDb && Array.isArray(existingInDb.photos) && existingInDb.photos.length > 0) {
        dataToSave.photos = existingInDb.photos;
        dataToSave.thumbnailBase64 = dataToSave.thumbnailBase64 || existingInDb.thumbnailBase64;
      }
    }

    this.sqliteClient.upsertCustomer(dataToSave);

    // 2. Actualizar caché en memoria RAM inmediatamente
    const persisted = { ...current, ...dataToSave };
    const cachedForComparison = {
      ...persisted,
      photos: [],
      thumbnailBase64: null
    };
    this.profilesCache.set(persisted.id, cachedForComparison);

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
      const syncPromise = this._syncToFirebase(persisted, options).catch(err => {
        console.warn(`[CustomerService] Error sincronizando a Firebase para "${persisted.name}" (${persisted.id}):`, err.message);
      });

      this.pendingSyncs.add(syncPromise);
      syncPromise.finally(() => this.pendingSyncs.delete(syncPromise));

      if (options.backgroundSync) {
        return { id: persisted.id, localSaved: true, queuedSync: true, syncPromise };
      }

      await syncPromise;
      return { id: persisted.id, localSaved: true, synced: true };
    }

    return { id: persisted.id, localSaved: true, synced: false };
  }

  /**
   * Espera a que todas las promesas de sincronización de fondo pendientes hacia Firebase se completen.
   * Garantiza consistencia en pruebas unitarias o antes del apagado del proceso.
   * @returns {Promise<void>}
   */
  async waitForPendingSyncs() {
    if (this.pendingSyncs.size === 0) return;
    await Promise.all(Array.from(this.pendingSyncs));
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
    const isClientName = /^Cliente #\d+$/i.test(customer.name?.trim() || "");
    const isClientExplicit = isClientName || customer.role === "client" || customer.isStaff === false;
    const isActuallyStaff = !isClientExplicit && (customer.isStaff === true && (customer.role === "barber" || String(customer.id).startsWith("staff_")));
    const firestoreData = {
      id: customer.id,
      name: customer.name || "Cliente",
      isStaff: isActuallyStaff,
      role: isActuallyStaff ? "barber" : "client",
      status: customer.status || (customer.visitCount > 1 ? "frequent" : "new"),
      firstSeen: customer.firstSeen || new Date().toISOString(),
      lastSeen: customer.lastSeen || new Date().toISOString(),
      visitCount: customer.visitCount || 1,
      appointmentCount: typeof customer.appointmentCount === "number" ? customer.appointmentCount : (customer.visitCount || 1),
      bestFaceScore: Number(customer.bestFaceScore || 0),
      thumbnailBase64: customer.thumbnailBase64 || null,
      thumbnailPath: uploadedThumbnailPath || customer.thumbnailPath || "",
      photos: Array.isArray(customer.photos) ? customer.photos : []
    };

    if (Array.isArray(customer.embeddings) && customer.embeddings.length > 0) {
      firestoreData.embeddings = customer.embeddings.map(e => {
        if (Array.isArray(e)) return { vector: e };
        if (e && typeof e === "object" && Array.isArray(e.vector)) return e;
        return null;
      }).filter(Boolean);
    }
    if (Array.isArray(customer.embedding)) {
      firestoreData.embedding = customer.embedding;
    } else if (firestoreData.embeddings?.[0]?.vector) {
      firestoreData.embedding = firestoreData.embeddings[0].vector;
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
   * Elimina un cliente de forma física completa (Hard Delete) de SQLite, Firestore y RAM.
   * 1) En SQLite local: DELETE FROM customers WHERE id = ?, DELETE FROM customer_embeddings WHERE customer_id = ?
   * 2) En Firestore si db o this.db está disponible: await db.collection("camera_catcher_people").doc(id).delete()
   * 3) Eliminar de la caché en memoria RAM: this.profilesCache.delete(id)
   * @param {string} id
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  async deleteCustomer(id, options = {}) {
    if (!id) return false;

    const firestoreDbId = options.databaseId || extractDatabaseIdFromFirestore(options.db || this.db);
    if (firestoreDbId && !this.customClientProvided && firestoreDbId !== this.databaseId) {
      this.initForDatabase(firestoreDbId, options);
    }

    try {
      // 1. En SQLite local: Borrado físico completo (Hard Delete)
      if (this.sqliteClient) {
        if (typeof this.sqliteClient.deleteCustomer === "function") {
          this.sqliteClient.deleteCustomer(id);
        } else if (this.sqliteClient.db) {
          try {
            this.sqliteClient.db.prepare("DELETE FROM customer_embeddings WHERE customer_id = ?").run(id);
            this.sqliteClient.db.prepare("DELETE FROM customers WHERE id = ?").run(id);
          } catch (sqlErr) {
            console.warn(`[CustomerService] Error eliminando cliente ${id} en SQLite:`, sqlErr.message);
          }
        }
      }

      // 2. En Firestore si db o this.db está disponible:
      const firestoreInstance = options.db || this.db;
      if (firestoreInstance) {
        try {
          let deleted = false;
          if (typeof firestoreInstance.collection === "function") {
            const col = firestoreInstance.collection("camera_catcher_people");
            if (col && typeof col.doc === "function") {
              const docRef = col.doc(id);
              if (docRef && typeof docRef.delete === "function") {
                await docRef.delete();
                deleted = true;
              }
            }
          }
          if (!deleted && typeof firestoreInstance.doc === "function") {
            const docRef = firestoreInstance.doc(`camera_catcher_people/${id}`);
            if (docRef && typeof docRef.delete === "function") {
              await docRef.delete();
              deleted = true;
            }
          }
        } catch (fsErr) {
          console.warn(`[CustomerService] Error eliminando cliente ${id} de Firestore:`, fsErr.message);
        }
      }

      // 3. Eliminar de la caché en memoria RAM
      this.profilesCache.delete(id);
      console.log(`[CustomerService] 🗑️ Borrado físico completo (Hard Delete) para "${id}" (SQLite, RAM y Firestore).`);
      return true;
    } catch (err) {
      console.error(`[CustomerService] Error en deleteCustomer para "${id}":`, err.message);
      return false;
    }
  }
}

// Instancia singleton por defecto
export const customerService = new CustomerService();
