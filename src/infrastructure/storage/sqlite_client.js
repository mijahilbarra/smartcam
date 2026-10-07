/**
 * Adaptador de Base de Datos Local SQLite
 * Gestiona el almacenamiento local de alta velocidad para clientes y embeddings biométricos
 * usando better-sqlite3 con soporte de modo WAL y serialización binaria de vectores Float32Array.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

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
   * @param {string} dbPath - Ruta al archivo sqlite (por defecto 'data/barberia.db' o ':memory:')
   */
  constructor(dbPath = "data/barberia.db") {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this._initTables();
    this._prepareStatements();
  }

  /**
   * Crea las tablas customers y customer_embeddings con claves foráneas e índices.
   * @private
   */
  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT DEFAULT 'Cliente',
        is_staff INTEGER DEFAULT 0,
        role TEXT DEFAULT 'client',
        first_seen TEXT,
        last_seen TEXT,
        visit_count INTEGER DEFAULT 1,
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
    `);
  }

  /**
   * Prepara sentencias SQL para máxima velocidad en ciclos repetitivos
   * @private
   */
  _prepareStatements() {
    this.stmtUpsertCustomer = this.db.prepare(`
      INSERT INTO customers (
        id, name, is_staff, role, first_seen, last_seen, visit_count,
        best_face_score, thumbnail_base64, thumbnail_path, photos_json, updated_at
      ) VALUES (
        @id, @name, @isStaff, @role, @firstSeen, @lastSeen, @visitCount,
        @bestFaceScore, @thumbnailBase64, @thumbnailPath, @photosJson, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, customers.name),
        is_staff = COALESCE(excluded.is_staff, customers.is_staff),
        role = COALESCE(excluded.role, customers.role),
        first_seen = COALESCE(customers.first_seen, excluded.first_seen),
        last_seen = COALESCE(excluded.last_seen, customers.last_seen),
        visit_count = COALESCE(excluded.visit_count, customers.visit_count),
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
      SELECT * FROM customers ORDER BY id ASC
    `);

    this.stmtGetAllEmbeddings = this.db.prepare(`
      SELECT * FROM customer_embeddings ORDER BY customer_id ASC, embedding_index ASC
    `);

    this.stmtDeleteCustomer = this.db.prepare(`
      DELETE FROM customers WHERE id = ?
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
      this.stmtUpsertCustomer.run({
        id: customer.id,
        name: customer.name || null,
        isStaff: isStaffInt,
        role: customer.role || null,
        firstSeen: customer.firstSeen || null,
        lastSeen: customer.lastSeen || nowIso,
        visitCount: typeof customer.visitCount === "number" ? customer.visitCount : null,
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
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      visitCount: row.visit_count,
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
      let photos = [];
      if (row.photos_json) {
        try {
          photos = JSON.parse(row.photos_json);
        } catch (_) {
          photos = [];
        }
      }

      return {
        id: row.id,
        name: row.name,
        isStaff: row.is_staff === 1,
        role: row.role,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        visitCount: row.visit_count,
        bestFaceScore: row.best_face_score,
        thumbnailBase64: row.thumbnail_base64,
        thumbnailPath: row.thumbnail_path,
        photos,
        embeddings: vectors,
        embedding: vectors[0] || null
      };
    });
  }

  /**
   * Elimina un cliente y todos sus embeddings en cascada
   * @param {string} id
   * @returns {boolean}
   */
  deleteCustomer(id) {
    const result = this.stmtDeleteCustomer.run(id);
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

// Instancia singleton por defecto
export const sqliteClient = new SQLiteClient();
