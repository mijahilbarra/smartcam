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
  constructor(dbPath) {
    this.dbPath = dbPath || getResolvedSqlitePath();
    if (this.dbPath !== ":memory:") {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
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
      CREATE TABLE IF NOT EXISTS customers (
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

      CREATE TABLE IF NOT EXISTS customer_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL,
        embedding_index INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL,
        sharpness_score REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        UNIQUE(customer_id, embedding_index)
      );

      CREATE INDEX IF NOT EXISTS idx_customer_embeddings_customer_id
        ON customer_embeddings(customer_id);

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        chair_id TEXT NOT NULL,
        chair_name TEXT,
        client_id TEXT,
        client_name TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_minutes INTEGER DEFAULT 0,
        status TEXT DEFAULT 'completed',
        best_face_score REAL DEFAULT 0,
        thumbnail_path TEXT,
        photos_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES customers(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments(client_id);
      CREATE INDEX IF NOT EXISTS idx_appointments_started_at ON appointments(started_at);
    `);

    // Asegurar compatibilidad si la tabla customers ya existía sin appointment_count o status
    try {
      this.db.exec(`ALTER TABLE customers ADD COLUMN appointment_count INTEGER DEFAULT 0;`);
    } catch (_) {
      // La columna ya existe
    }
    try {
      this.db.exec(`ALTER TABLE customers ADD COLUMN status TEXT DEFAULT 'new';`);
    } catch (_) {
      // La columna ya existe
    }
  }

  /**
   * Prepara sentencias SQL para máxima velocidad en ciclos repetitivos
   * @private
   */
  _prepareStatements() {
    this.stmtUpsertCustomer = this.db.prepare(`
      INSERT INTO customers (
        id, name, is_staff, role, status, first_seen, last_seen, visit_count, appointment_count,
        best_face_score, thumbnail_base64, thumbnail_path, photos_json, updated_at
      ) VALUES (
        @id, @name, @isStaff, @role, @status, @firstSeen, @lastSeen, @visitCount, @appointmentCount,
        @bestFaceScore, @thumbnailBase64, @thumbnailPath, @photosJson, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, customers.name),
        is_staff = COALESCE(excluded.is_staff, customers.is_staff),
        role = COALESCE(excluded.role, customers.role),
        status = COALESCE(excluded.status, customers.status),
        first_seen = COALESCE(customers.first_seen, excluded.first_seen),
        last_seen = COALESCE(excluded.last_seen, customers.last_seen),
        visit_count = COALESCE(excluded.visit_count, customers.visit_count),
        appointment_count = COALESCE(excluded.appointment_count, customers.appointment_count),
        best_face_score = CASE WHEN excluded.best_face_score IS NOT NULL AND excluded.best_face_score > customers.best_face_score THEN excluded.best_face_score ELSE customers.best_face_score END,
        thumbnail_base64 = COALESCE(excluded.thumbnail_base64, customers.thumbnail_base64),
        thumbnail_path = COALESCE(excluded.thumbnail_path, customers.thumbnail_path),
        photos_json = COALESCE(excluded.photos_json, customers.photos_json),
        updated_at = datetime('now')
    `);

    this.stmtUpsertEmbedding = this.db.prepare(`
      INSERT INTO customer_embeddings (
        customer_id, embedding_index, embedding_blob, sharpness_score, created_at
      ) VALUES (
        @customerId, @embeddingIndex, @embeddingBlob, @sharpnessScore, datetime('now')
      )
      ON CONFLICT(customer_id, embedding_index) DO UPDATE SET
        embedding_blob = excluded.embedding_blob,
        sharpness_score = excluded.sharpness_score,
        created_at = datetime('now')
    `);

    this.stmtDeleteCustomerEmbeddings = this.db.prepare(`
      DELETE FROM customer_embeddings WHERE customer_id = ?
    `);

    this.stmtGetCustomerById = this.db.prepare(`
      SELECT * FROM customers WHERE id = ?
    `);

    this.stmtGetEmbeddingsByCustomerId = this.db.prepare(`
      SELECT * FROM customer_embeddings WHERE customer_id = ? ORDER BY embedding_index ASC
    `);

    this.stmtGetAllCustomers = this.db.prepare(`
      SELECT id, name, is_staff, role, status, first_seen, last_seen, visit_count, appointment_count, best_face_score
      FROM customers
    `);

    this.stmtGetAllEmbeddings = this.db.prepare(`
      SELECT * FROM customer_embeddings ORDER BY customer_id ASC, embedding_index ASC
    `);

    this.stmtDeleteCustomer = this.db.prepare(`
      DELETE FROM customers WHERE id = ?
    `);

    this.stmtUpsertAppointment = this.db.prepare(`
      INSERT INTO appointments (
        id, chair_id, chair_name, client_id, client_name, started_at, ended_at,
        duration_minutes, status, best_face_score, thumbnail_path, photos_json, updated_at
      ) VALUES (
        @id, @chairId, @chairName, @clientId, @clientName, @startedAt, @endedAt,
        @durationMinutes, @status, @bestFaceScore, @thumbnailPath, @photosJson, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        chair_id = COALESCE(excluded.chair_id, appointments.chair_id),
        chair_name = COALESCE(excluded.chair_name, appointments.chair_name),
        client_id = COALESCE(excluded.client_id, appointments.client_id),
        client_name = COALESCE(excluded.client_name, appointments.client_name),
        started_at = COALESCE(excluded.started_at, appointments.started_at),
        ended_at = COALESCE(excluded.ended_at, appointments.ended_at),
        duration_minutes = COALESCE(excluded.duration_minutes, appointments.duration_minutes),
        status = COALESCE(excluded.status, appointments.status),
        best_face_score = COALESCE(excluded.best_face_score, appointments.best_face_score),
        thumbnail_path = COALESCE(excluded.thumbnail_path, appointments.thumbnail_path),
        photos_json = COALESCE(excluded.photos_json, appointments.photos_json),
        updated_at = datetime('now')
    `);

    this.stmtGetAppointmentById = this.db.prepare(`
      SELECT * FROM appointments WHERE id = ?
    `);

    this.stmtGetAppointmentsByClient = this.db.prepare(`
      SELECT * FROM appointments WHERE client_id = ? ORDER BY started_at DESC
    `);

    this.stmtGetAllAppointments = this.db.prepare(`
      SELECT * FROM appointments ORDER BY started_at DESC
    `);

    this.stmtDeleteAppointment = this.db.prepare(`
      DELETE FROM appointments WHERE id = ?
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
            this.stmtUpsertEmbedding.run({
              customerId: customer.id,
              embeddingIndex: idx,
              embeddingBlob: blob,
              sharpnessScore: score
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
   */
  saveEmbedding(customerId, embeddingIndex, vector, sharpnessScore = 0) {
    const blob = vectorToBlob(vector);
    if (!blob) return;
    this.stmtUpsertEmbedding.run({
      customerId,
      embeddingIndex,
      embeddingBlob: blob,
      sharpnessScore: Number(sharpnessScore || 0)
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
      embeddingsByCustomer.get(embRow.customer_id).push(blobToVector(embRow.embedding_blob));
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
        embedding: vectors[0] || null
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
      durationMinutes: typeof appointment.durationMinutes === "number" ? appointment.durationMinutes : (appointment.duration_minutes || 0),
      status: appointment.status || "completed",
      bestFaceScore: typeof appointment.bestFaceScore === "number" ? appointment.bestFaceScore : (appointment.best_face_score || 0),
      thumbnailPath: appointment.thumbnailPath || appointment.thumbnail_path || null,
      photosJson
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
    this.db.exec("DELETE FROM customer_embeddings; DELETE FROM customers;");
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
