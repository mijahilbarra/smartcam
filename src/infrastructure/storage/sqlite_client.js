/**
 * Adaptador de Base de Datos Local SQLite
 * Gestiona el almacenamiento local de alta velocidad para clientes y embeddings biométricos
 * usando better-sqlite3 con soporte de modo WAL y serialización binaria de vectores Float32Array.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getResolvedDatabaseId } from "../firebase/firebase_admin.js";

const DATA_DIR = process.env.SQLITE_DATA_DIR || path.join(process.cwd(), "data");

/**
 * Resuelve la ruta del archivo SQLite según el databaseId y opciones
 * Garantiza paridad con los entornos de Firestore ('(default)' y 'test'):
 * - Si se define process.env.SQLITE_DB_PATH o options.dbPath, usar ese path.
 * - Si databaseId === "(default)": resolver a path.join(DATA_DIR, "barberia.db").
 * - Si databaseId === "test": resolver a path.join(DATA_DIR, "barberia_test.db").
 * - Para cualquier otro databaseId: resolver a path.join(DATA_DIR, `barberia_${databaseId}.db`).
 * @param {string} [databaseId]
 * @param {Object} [options]
 * @returns {string}
 */
export function getResolvedSqlitePath(databaseId, options = {}) {
  if (options.dbPath) {
    return options.dbPath;
  }
  if (process.env.SQLITE_DB_PATH) {
    return process.env.SQLITE_DB_PATH;
  }
  if (databaseId === ":memory:") {
    return ":memory:";
  }

  const dataDir = options.dataDir || DATA_DIR;
  const targetId = databaseId || getResolvedDatabaseId(options);

  if (targetId === "(default)") {
    return path.join(dataDir, "barberia.db");
  }
  if (targetId === "test") {
    return path.join(dataDir, "barberia_test.db");
  }
  return path.join(dataDir, `barberia_${targetId}.db`);
}

// Caché de instancias singleton por databaseId/ruta
const clientInstances = new Map();

/**
 * Obtiene o crea una instancia singleton de SQLiteClient por databaseId
 * @param {string} [databaseId]
 * @param {Object} [options]
 * @returns {SQLiteClient}
 */
export function getSqliteClient(databaseId, options = {}) {
  const targetId = databaseId || getResolvedDatabaseId(options);
  const resolvedPath = getResolvedSqlitePath(targetId, options);
  const cacheKey = options.cacheKey || `${targetId}:${resolvedPath}`;

  if (!clientInstances.has(cacheKey)) {
    const client = new SQLiteClient(resolvedPath);
    clientInstances.set(cacheKey, client);
  }
  return clientInstances.get(cacheKey);
}

/**
 * Limpia y cierra las instancias singleton de SQLiteClient en caché (útil para pruebas)
 */
export function resetSqliteClients() {
  for (const client of clientInstances.values()) {
    try {
      client.close();
    } catch (_) {}
  }
  clientInstances.clear();
}

/**
 * Convierte un vector de características (Array de números o Float32Array) a un Buffer binario BLOB
 * @param {Array<number>|Float32Array} vector
 * @returns {Buffer|null}
 */
export function vectorToBlob(vector) {
  if (!vector) return null;
  const float32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Reconstruye un array de números a partir de un Buffer binario BLOB
 * @param {Buffer|Uint8Array} buffer
 * @returns {Array<number>|null}
 */
export function blobToVector(buffer) {
  if (!buffer) return null;
  const nodeBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const float32 = new Float32Array(
    nodeBuf.buffer,
    nodeBuf.byteOffset,
    nodeBuf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(float32);
}

export class SQLiteClient {
  /**
   * Inicializa la conexión SQLite y crea las tablas si no existen.
   * @param {string} [dbPath] - Ruta al archivo sqlite (resuelto por defecto según entorno o ':memory:')
   */
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath || getResolvedSqlitePath();
    this.tables = {
      customers: options.customersTable || options.tables?.customers || "customers",
      customerEmbeddings: options.customerEmbeddingsTable || options.tables?.customerEmbeddings || "customer_embeddings",
      appointments: options.appointmentsTable || options.tables?.appointments || "appointments"
    };

    if (this.dbPath !== ":memory:") {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = options.dbInstance || new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this._initTables();
    this._prepareStatements();
  }

  /**
   * Crea las tablas customers, customer_embeddings y appointments con claves foráneas e índices.
   * @private
   */
  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.customers} (
        id TEXT PRIMARY KEY,
        name TEXT DEFAULT 'Cliente',
        is_staff INTEGER DEFAULT 0,
        role TEXT DEFAULT 'client',
        status TEXT DEFAULT 'new',
        first_seen TEXT,
        last_seen TEXT,
        visit_count INTEGER DEFAULT 1,
        appointment_count INTEGER DEFAULT 0,
        best_face_score REAL DEFAULT 0,
        thumbnail_base64 TEXT,
        thumbnail_path TEXT,
        photos_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ${this.tables.customerEmbeddings} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL,
        embedding_index INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL,
        sharpness_score REAL DEFAULT 0,
        pose TEXT DEFAULT 'frontal',
        pose_label TEXT DEFAULT 'Frontal',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (customer_id) REFERENCES ${this.tables.customers}(id) ON DELETE CASCADE,
        UNIQUE(customer_id, embedding_index)
      );

      CREATE INDEX IF NOT EXISTS idx_${this.tables.customerEmbeddings}_customer_id
        ON ${this.tables.customerEmbeddings}(customer_id);

      CREATE TABLE IF NOT EXISTS ${this.tables.appointments} (
        id TEXT PRIMARY KEY,
        chair_id TEXT NOT NULL,
        chair_name TEXT,
        client_id TEXT,
        client_name TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        started_epoch INTEGER,
        ended_epoch INTEGER,
        duration_minutes INTEGER DEFAULT 0,
        status TEXT DEFAULT 'completed',
        best_face_score REAL DEFAULT 0,
        thumbnail_path TEXT,
        photos_json TEXT,
        embeddings_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES ${this.tables.customers}(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_${this.tables.appointments}_client_id ON ${this.tables.appointments}(client_id);
      CREATE INDEX IF NOT EXISTS idx_${this.tables.appointments}_started_at ON ${this.tables.appointments}(started_at);
    `);

    // Asegurar compatibilidad si las tablas ya existían con columnas faltantes
    try {
      this.db.exec(`ALTER TABLE ${this.tables.customers} ADD COLUMN appointment_count INTEGER DEFAULT 0;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.customers} ADD COLUMN status TEXT DEFAULT 'new';`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.customers} ADD COLUMN thumbnail_path TEXT;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.customers} ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.customerEmbeddings} ADD COLUMN pose TEXT DEFAULT 'frontal';`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.customerEmbeddings} ADD COLUMN pose_label TEXT DEFAULT 'Frontal';`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.appointments} ADD COLUMN thumbnail_path TEXT;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.appointments} ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.appointments} ADD COLUMN started_epoch INTEGER;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.appointments} ADD COLUMN ended_epoch INTEGER;`);
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE ${this.tables.appointments} ADD COLUMN embeddings_count INTEGER;`);
    } catch (_) {}
  }

  /**
   * Prepara sentencias SQL para máxima velocidad en ciclos repetitivos
   * @private
   */
  _prepareStatements() {
    this.stmtUpsertCustomer = this.db.prepare(`
      INSERT INTO ${this.tables.customers} (
        id, name, is_staff, role, status, first_seen, last_seen, visit_count, appointment_count,
        best_face_score, thumbnail_base64, thumbnail_path, photos_json, updated_at
      ) VALUES (
        @id, @name, @isStaff, @role, @status, @firstSeen, @lastSeen, @visitCount, @appointmentCount,
        @bestFaceScore, @thumbnailBase64, @thumbnailPath, @photosJson, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, ${this.tables.customers}.name),
        is_staff = COALESCE(excluded.is_staff, ${this.tables.customers}.is_staff),
        role = COALESCE(excluded.role, ${this.tables.customers}.role),
        status = COALESCE(excluded.status, ${this.tables.customers}.status),
        first_seen = COALESCE(${this.tables.customers}.first_seen, excluded.first_seen),
        last_seen = COALESCE(excluded.last_seen, ${this.tables.customers}.last_seen),
        visit_count = COALESCE(excluded.visit_count, ${this.tables.customers}.visit_count),
        appointment_count = COALESCE(excluded.appointment_count, ${this.tables.customers}.appointment_count),
        best_face_score = CASE WHEN excluded.best_face_score IS NOT NULL AND excluded.best_face_score > ${this.tables.customers}.best_face_score THEN excluded.best_face_score ELSE ${this.tables.customers}.best_face_score END,
        thumbnail_base64 = COALESCE(excluded.thumbnail_base64, ${this.tables.customers}.thumbnail_base64),
        thumbnail_path = COALESCE(excluded.thumbnail_path, ${this.tables.customers}.thumbnail_path),
        photos_json = COALESCE(excluded.photos_json, ${this.tables.customers}.photos_json),
        updated_at = datetime('now')
    `);

    this.stmtUpsertEmbedding = this.db.prepare(`
      INSERT INTO ${this.tables.customerEmbeddings} (
        customer_id, embedding_index, embedding_blob, sharpness_score, pose, pose_label, created_at
      ) VALUES (
        @customerId, @embeddingIndex, @embeddingBlob, @sharpnessScore, @pose, @poseLabel, datetime('now')
      )
      ON CONFLICT(customer_id, embedding_index) DO UPDATE SET
        embedding_blob = excluded.embedding_blob,
        sharpness_score = excluded.sharpness_score,
        pose = COALESCE(excluded.pose, ${this.tables.customerEmbeddings}.pose),
        pose_label = COALESCE(excluded.pose_label, ${this.tables.customerEmbeddings}.pose_label),
        created_at = datetime('now')
    `);

    this.stmtDeleteCustomerEmbeddings = this.db.prepare(`
      DELETE FROM ${this.tables.customerEmbeddings} WHERE customer_id = ?
    `);

    this.stmtGetCustomerById = this.db.prepare(`
      SELECT * FROM ${this.tables.customers} WHERE id = ?
    `);

    this.stmtGetEmbeddingsByCustomerId = this.db.prepare(`
      SELECT * FROM ${this.tables.customerEmbeddings} WHERE customer_id = ? ORDER BY embedding_index ASC
    `);

    this.stmtGetAllCustomers = this.db.prepare(`
      SELECT id, name, is_staff, role, status, first_seen, last_seen, visit_count, appointment_count, best_face_score
      FROM ${this.tables.customers}
    `);

    this.stmtGetAllEmbeddings = this.db.prepare(`
      SELECT * FROM ${this.tables.customerEmbeddings} ORDER BY customer_id ASC, embedding_index ASC
    `);

    this.stmtDeleteCustomer = this.db.prepare(`
      DELETE FROM ${this.tables.customers} WHERE id = ?
    `);

    this.stmtUpsertAppointment = this.db.prepare(`
      INSERT INTO ${this.tables.appointments} (
        id, chair_id, chair_name, client_id, client_name, started_at, ended_at,
        started_epoch, ended_epoch, duration_minutes, status, best_face_score,
        thumbnail_path, photos_json, embeddings_count, updated_at
      ) VALUES (
        @id, @chairId, @chairName, @clientId, @clientName, @startedAt, @endedAt,
        @startedEpoch, @endedEpoch, @durationMinutes, @status, @bestFaceScore,
        @thumbnailPath, @photosJson, @embeddingsCount, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        chair_id = COALESCE(excluded.chair_id, ${this.tables.appointments}.chair_id),
        chair_name = COALESCE(excluded.chair_name, ${this.tables.appointments}.chair_name),
        client_id = COALESCE(excluded.client_id, ${this.tables.appointments}.client_id),
        client_name = COALESCE(excluded.client_name, ${this.tables.appointments}.client_name),
        started_at = COALESCE(excluded.started_at, ${this.tables.appointments}.started_at),
        ended_at = COALESCE(excluded.ended_at, ${this.tables.appointments}.ended_at),
        started_epoch = COALESCE(excluded.started_epoch, ${this.tables.appointments}.started_epoch),
        ended_epoch = COALESCE(excluded.ended_epoch, ${this.tables.appointments}.ended_epoch),
        duration_minutes = COALESCE(excluded.duration_minutes, ${this.tables.appointments}.duration_minutes),
        status = COALESCE(excluded.status, ${this.tables.appointments}.status),
        best_face_score = COALESCE(excluded.best_face_score, ${this.tables.appointments}.best_face_score),
        thumbnail_path = COALESCE(excluded.thumbnail_path, ${this.tables.appointments}.thumbnail_path),
        photos_json = COALESCE(excluded.photos_json, ${this.tables.appointments}.photos_json),
        embeddings_count = COALESCE(excluded.embeddings_count, ${this.tables.appointments}.embeddings_count),
        updated_at = datetime('now')
    `);

    this.stmtGetAppointmentById = this.db.prepare(`
      SELECT * FROM ${this.tables.appointments} WHERE id = ?
    `);

    this.stmtGetAppointmentsByClient = this.db.prepare(`
      SELECT * FROM ${this.tables.appointments} WHERE client_id = ? ORDER BY started_at DESC
    `);

    this.stmtGetAllAppointments = this.db.prepare(`
      SELECT * FROM ${this.tables.appointments} ORDER BY started_at DESC
    `);

    this.stmtDeleteAppointment = this.db.prepare(`
      DELETE FROM ${this.tables.appointments} WHERE id = ?
    `);
  }

  /**
   * Inserta o actualiza un cliente y sus embeddings en una transacción atómica.
   * @param {Object} customer
   * @returns {Object} El cliente persistido
   */
  upsertCustomer(customer) {
    if (!customer || !customer.id) {
      throw new Error("El cliente debe contener al menos un id válido.");
    }

    const photosJson = customer.photos ? JSON.stringify(customer.photos) : null;
    const isStaffInt = typeof customer.isStaff === "boolean" ? (customer.isStaff ? 1 : 0) : null;
    const nowIso = new Date().toISOString();

    const tx = this.db.transaction(() => {
      const resolvedStatus = customer.status || ((customer.visitCount || 0) > 1 ? "frequent" : "new");
      this.stmtUpsertCustomer.run({
        id: customer.id,
        name: customer.name || null,
        isStaff: isStaffInt,
        role: customer.role || null,
        status: resolvedStatus,
        firstSeen: customer.firstSeen || null,
        lastSeen: customer.lastSeen || nowIso,
        visitCount: typeof customer.visitCount === "number" ? customer.visitCount : null,
        appointmentCount: typeof customer.appointmentCount === "number" ? customer.appointmentCount : null,
        bestFaceScore: typeof customer.bestFaceScore === "number" ? customer.bestFaceScore : null,
        thumbnailBase64: customer.thumbnailBase64 || null,
        thumbnailPath: customer.thumbnailPath || null,
        photosJson
      });

      // Procesar galería de embeddings si se proporciona
      let embeddingsToSave = [];
      if (Array.isArray(customer.embeddings) && customer.embeddings.length > 0) {
        embeddingsToSave = customer.embeddings;
      } else if (Array.isArray(customer.embedding)) {
        embeddingsToSave = [customer.embedding];
      }

      if (embeddingsToSave.length > 0) {
        // Reemplazar galería completa de embeddings para garantizar correspondencia 1:1
        this.stmtDeleteCustomerEmbeddings.run(customer.id);
        for (let idx = 0; idx < embeddingsToSave.length; idx++) {
          const item = embeddingsToSave[idx];
          const rawVector = Array.isArray(item) ? item : (item && Array.isArray(item.vector) ? item.vector : null);
          if (rawVector) {
            const blob = vectorToBlob(rawVector);
            const score = item && typeof item.sharpnessScore === "number" ? item.sharpnessScore : (customer.bestFaceScore || 0);
            const pose = (item && item.pose) || customer.photos?.[idx]?.pose || 'frontal';
            const poseLabel = (item && item.poseLabel) || customer.photos?.[idx]?.poseLabel || (pose === 'frontal' ? 'Frontal' : pose);
            this.stmtUpsertEmbedding.run({
              customerId: customer.id,
              embeddingIndex: idx,
              embeddingBlob: blob,
              sharpnessScore: score,
              pose,
              poseLabel
            });
          }
        }
      }
    });

    tx();
    return customer;
  }

  /**
   * Guarda o actualiza un embedding individual en una posición específica de la galería
   * @param {string} customerId
   * @param {number} embeddingIndex
   * @param {Array<number>} vector
   * @param {number} sharpnessScore
   * @param {string} [pose='frontal']
   * @param {string} [poseLabel='Frontal']
   */
  saveEmbedding(customerId, embeddingIndex, vector, sharpnessScore = 0, pose = 'frontal', poseLabel = 'Frontal') {
    const blob = vectorToBlob(vector);
    if (!blob) return;
    this.stmtUpsertEmbedding.run({
      customerId,
      embeddingIndex,
      embeddingBlob: blob,
      sharpnessScore: Number(sharpnessScore || 0),
      pose: pose || 'frontal',
      poseLabel: poseLabel || 'Frontal'
    });
  }

  /**
   * Obtiene un cliente por su ID junto con su galería de fotos y embeddings deserializados
   * @param {string} id
   * @returns {Object|null}
   */
  getCustomerById(id) {
    const row = this.stmtGetCustomerById.get(id);
    if (!row) return null;

    const embeddingRows = this.stmtGetEmbeddingsByCustomerId.all(id);
    const vectors = embeddingRows.map(r => blobToVector(r.embedding_blob));

    return {
      id: row.id,
      name: row.name,
      isStaff: row.is_staff === 1,
      role: row.role,
      status: row.status || (row.visit_count > 1 ? "frequent" : "new"),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      visitCount: row.visit_count,
      appointmentCount: row.appointment_count,
      bestFaceScore: row.best_face_score,
      thumbnailBase64: row.thumbnail_base64,
      thumbnailPath: row.thumbnail_path,
      photos: row.photos_json ? JSON.parse(row.photos_json) : [],
      embeddings: vectors,
      embedding: vectors[0] || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Obtiene todos los perfiles formateados listos para comparación biométrica rápida con identifyFace.
   * Ejecuta en <1ms gracias a WAL mode y transacciones SQLite locales.
   * @returns {Array<Object>}
   */
  getAllComparisonProfiles() {
    const customers = this.stmtGetAllCustomers.all();
    const allEmbeddings = this.stmtGetAllEmbeddings.all();

    // Mapear embeddings por customer_id
    const embeddingsByCustomer = new Map();
    for (const embRow of allEmbeddings) {
      if (!embeddingsByCustomer.has(embRow.customer_id)) {
        embeddingsByCustomer.set(embRow.customer_id, []);
      }
      embeddingsByCustomer.get(embRow.customer_id).push({
        vector: blobToVector(embRow.embedding_blob),
        pose: embRow.pose || 'frontal',
        poseLabel: embRow.pose_label || 'Frontal',
        sharpnessScore: embRow.sharpness_score || 0
      });
    }

    return customers.map(row => {
      const vectors = embeddingsByCustomer.get(row.id) || [];

      return {
        id: row.id,
        name: row.name,
        isStaff: row.is_staff === 1,
        role: row.role,
        status: row.status || (row.visit_count > 1 ? "frequent" : "new"),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        visitCount: row.visit_count,
        appointmentCount: row.appointment_count,
        bestFaceScore: row.best_face_score,
        thumbnailBase64: null,
        thumbnailPath: null,
        photos: [],
        embeddings: vectors,
        embedding: vectors[0]?.vector || (Array.isArray(vectors[0]) ? vectors[0] : null)
      };
    });
  }

  /**
   * Elimina un cliente y todos sus embeddings en cascada (Hard Delete)
   * @param {string} id
   * @returns {boolean}
   */
  deleteCustomer(id) {
    try {
      this.stmtDeleteCustomerEmbeddings.run(id);
    } catch (_) {}
    const result = this.stmtDeleteCustomer.run(id);
    return result.changes > 0;
  }

  /**
   * Guarda o actualiza una atención (appointment)
   * @param {Object} appointment
   * @returns {Object}
   */
  saveAppointment(appointment) {
    if (!appointment || !appointment.id) {
      throw new Error("La atención (appointment) debe contener al menos un id válido.");
    }
    const photosJson = appointment.photos ? JSON.stringify(appointment.photos) : (appointment.photosJson || null);

    this.stmtUpsertAppointment.run({
      id: appointment.id,
      chairId: appointment.chairId || appointment.chair_id || "silla_corte_1",
      chairName: appointment.chairName || appointment.chair_name || "Silla de Corte 1",
      clientId: appointment.clientId || appointment.client_id || null,
      clientName: appointment.clientName || appointment.client_name || null,
      startedAt: appointment.startedAt || appointment.started_at || new Date().toISOString(),
      endedAt: appointment.endedAt || appointment.ended_at || null,
      startedEpoch: appointment.startedEpoch || appointment.started_epoch || (appointment.startedAt ? new Date(appointment.startedAt).getTime() : null),
      endedEpoch: appointment.endedEpoch || appointment.ended_epoch || (appointment.endedAt ? new Date(appointment.endedAt).getTime() : null),
      durationMinutes: typeof appointment.durationMinutes === "number" ? appointment.durationMinutes : (appointment.duration_minutes || 0),
      status: appointment.status || "completed",
      bestFaceScore: typeof appointment.bestFaceScore === "number" ? appointment.bestFaceScore : (appointment.best_face_score || 0),
      thumbnailPath: appointment.thumbnailPath || appointment.thumbnail_path || null,
      photosJson,
      embeddingsCount: Array.isArray(appointment.embeddings) ? appointment.embeddings.length : (appointment.embeddingsCount || 0)
    });

    return appointment;
  }

  /**
   * Obtiene una atención por su ID
   * @param {string} id
   * @returns {Object|null}
   */
  getAppointmentById(id) {
    const row = this.stmtGetAppointmentById.get(id);
    if (!row) return null;
    return {
      id: row.id,
      chairId: row.chair_id,
      chairName: row.chair_name,
      clientId: row.client_id,
      clientName: row.client_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMinutes: row.duration_minutes,
      status: row.status,
      bestFaceScore: row.best_face_score,
      thumbnailPath: row.thumbnail_path,
      photos: row.photos_json ? JSON.parse(row.photos_json) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Obtiene todas las atenciones filtradas según criterios (clientId, chairId, status, etc.)
   * @param {Object} [filters]
   * @returns {Array<Object>}
   */
  getAppointments(filters = {}) {
    let query = `SELECT * FROM appointments WHERE 1=1`;
    const params = [];

    if (filters.clientId) {
      query += ` AND client_id = ?`;
      params.push(filters.clientId);
    }
    if (filters.chairId) {
      query += ` AND chair_id = ?`;
      params.push(filters.chairId);
    }
    if (filters.status) {
      query += ` AND status = ?`;
      params.push(filters.status);
    }
    query += ` ORDER BY started_at DESC`;

    const rows = this.db.prepare(query).all(...params);
    return rows.map(row => ({
      id: row.id,
      chairId: row.chair_id,
      chairName: row.chair_name,
      clientId: row.client_id,
      clientName: row.client_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMinutes: row.duration_minutes,
      status: row.status,
      bestFaceScore: row.best_face_score,
      thumbnailPath: row.thumbnail_path,
      photos: row.photos_json ? JSON.parse(row.photos_json) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  /**
   * Obtiene todas las atenciones asociadas a un cliente específico
   * @param {string} clientId
   * @returns {Array<Object>}
   */
  getAppointmentsByClient(clientId) {
    const rows = this.stmtGetAppointmentsByClient.all(clientId);
    return rows.map(row => ({
      id: row.id,
      chairId: row.chair_id,
      chairName: row.chair_name,
      clientId: row.client_id,
      clientName: row.client_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMinutes: row.duration_minutes,
      status: row.status,
      bestFaceScore: row.best_face_score,
      thumbnailPath: row.thumbnail_path,
      photos: row.photos_json ? JSON.parse(row.photos_json) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  /**
   * Elimina una atención por su ID
   * @param {string} id
   * @returns {boolean}
   */
  deleteAppointment(id) {
    const result = this.stmtDeleteAppointment.run(id);
    return result.changes > 0;
  }


  /**
   * Limpia todas las tablas (útil para pruebas unitarias)
   */
  clearAll() {
    this.db.exec(`DELETE FROM ${this.tables.customerEmbeddings}; DELETE FROM ${this.tables.customers}; DELETE FROM ${this.tables.appointments};`);
  }

  /**
   * Cierra la base de datos
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

// Instancia singleton por defecto según el entorno activo
export const sqliteClient = getSqliteClient();
