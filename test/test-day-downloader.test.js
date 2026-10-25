/**
 * Test Suite: Herramienta de Descarga y Fusión Diaria (download-and-merge-day)
 * Valida la lógica de timezone (America/Lima UTC-5), filtrado y ordenamiento de chunks,
 * listado paginado y descarga con streams en GoogleDriveClient.
 */

import test, { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { GoogleDriveClient } from "../src/infrastructure/storage/gdrive_client.js";
import {
  parseArgs,
  parseChunkTimestamp,
  calculateDateRange,
  filterAndSortDayChunks,
  formatBytes,
  formatDuration,
  renderProgressBar,
  downloadAndMergeDay
} from "../tools/download-and-merge-day.js";

describe("Herramienta CLI: Descarga y Fusión Diaria (Timezone Perú UTC-5)", () => {
  describe("1. Lógica de Timezone y Filtrado de Chunks", () => {
    it("calcula los rangos de epoch y nombres de carpeta UTC correctamente para Perú", () => {
      const range = calculateDateRange("2026-10-24", "America/Lima");
      assert.strictEqual(range.folderDay1, "2026-10-24");
      assert.strictEqual(range.folderDay2, "2026-10-25");
      assert.strictEqual(range.offset, "-05:00");

      // 00:00:00 -05:00 = 05:00:00 UTC
      assert.strictEqual(new Date(range.startOfDay).toISOString(), "2026-10-24T05:00:00.000Z");
      // 23:59:59.999 -05:00 = 04:59:59.999 UTC del día siguiente
      assert.strictEqual(new Date(range.endOfDay).toISOString(), "2026-10-25T04:59:59.999Z");
    });

    it("extrae componentes de timestamp y epoch UTC de nombres de chunks", () => {
      const parsed = parseChunkTimestamp("chunk_20261024_160005.mp4");
      assert.ok(parsed);
      assert.strictEqual(parsed.year, 2026);
      assert.strictEqual(parsed.month, 10);
      assert.strictEqual(parsed.day, 24);
      assert.strictEqual(parsed.hour, 16);
      assert.strictEqual(parsed.min, 0);
      assert.strictEqual(parsed.sec, 5);
      assert.strictEqual(parsed.epoch, Date.UTC(2026, 9, 24, 16, 0, 5));

      assert.strictEqual(parseChunkTimestamp("archivo_invalido.mp4"), null);
      assert.strictEqual(parseChunkTimestamp(""), null);
      assert.strictEqual(parseChunkTimestamp(null), null);
    });

    it("incluye chunk_20261024_160005.mp4 (11:00 AM Perú) en el día 2026-10-24", () => {
      const files = [
        { id: "f1", name: "chunk_20261024_160005.mp4", size: 24000000 }
      ];
      const matched = filterAndSortDayChunks(files, "2026-10-24", "America/Lima");
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].name, "chunk_20261024_160005.mp4");
      assert.match(matched[0].localTime, /11:00:05/);
    });

    it("incluye chunk_20261025_011333.mp4 (08:13 PM Perú del día 24) en el día 2026-10-24", () => {
      const files = [
        { id: "f2", name: "chunk_20261025_011333.mp4", size: 39000000 }
      ];
      const matched = filterAndSortDayChunks(files, "2026-10-24", "America/Lima");
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].name, "chunk_20261025_011333.mp4");
      assert.match(matched[0].localTime, /8:13:33|20:13:33/);
    });

    it("NO incluye chunk_20261024_010957.mp4 (08:09 PM Perú del día 23) en el día 2026-10-24", () => {
      const files = [
        { id: "f3", name: "chunk_20261024_010957.mp4", size: 45000000 }
      ];
      const matched = filterAndSortDayChunks(files, "2026-10-24", "America/Lima");
      assert.strictEqual(matched.length, 0);
    });

    it("ordena cronológicamente los chunks de ambas carpetas UTC que caen en el día de Perú", () => {
      const files = [
        // Chunks en orden desordenado y provenientes de ambos días UTC:
        { id: "f_night", name: "chunk_20261025_011333.mp4", size: 100 }, // 20:13 del 24
        { id: "f_prev_day", name: "chunk_20261024_010957.mp4", size: 100 }, // 20:09 del 23 (debe quedar fuera)
        { id: "f_morning", name: "chunk_20261024_160005.mp4", size: 100 }, // 11:00 del 24
        { id: "f_afternoon", name: "chunk_20261024_203305.mp4", size: 100 }, // 15:33 del 24
        { id: "f_next_day", name: "chunk_20261025_050005.mp4", size: 100 } // 00:00 del 25 (debe quedar fuera)
      ];

      const matched = filterAndSortDayChunks(files, "2026-10-24", "America/Lima");
      assert.strictEqual(matched.length, 3);
      assert.strictEqual(matched[0].name, "chunk_20261024_160005.mp4");
      assert.strictEqual(matched[1].name, "chunk_20261024_203305.mp4");
      assert.strictEqual(matched[2].name, "chunk_20261025_011333.mp4");
    });
  });

  describe("2. Parseo de Argumentos CLI y Utilidades de Formato", () => {
    it("parsea argumentos CLI correctamente con banderas y valores", () => {
      const parsed = parseArgs([
        "--date", "2026-10-24",
        "--output", "custom_output.mp4",
        "--chunks-dir", "custom_chunks",
        "--clean-chunks",
        "--force",
        "--dry-run",
        "--tz", "America/Lima"
      ]);

      assert.strictEqual(parsed.date, "2026-10-24");
      assert.strictEqual(parsed.output, "custom_output.mp4");
      assert.strictEqual(parsed.chunksDir, "custom_chunks");
      assert.strictEqual(parsed.cleanChunks, true);
      assert.strictEqual(parsed.force, true);
      assert.strictEqual(parsed.dryRun, true);
      assert.strictEqual(parsed.tz, "America/Lima");
    });

    it("formatea tamaños en bytes de manera amigable", () => {
      assert.strictEqual(formatBytes(500), "500 B");
      assert.strictEqual(formatBytes(2048), "2.00 KB");
      assert.strictEqual(formatBytes(50 * 1024 * 1024), "50.00 MB");
      assert.strictEqual(formatBytes(2.5 * 1024 * 1024 * 1024), "2.50 GB");
    });

    it("formatea duraciones en formato HH:MM:SS", () => {
      assert.strictEqual(formatDuration(0), "00:00:00");
      assert.strictEqual(formatDuration(45), "00:00:45");
      assert.strictEqual(formatDuration(125), "00:02:05");
      assert.strictEqual(formatDuration(3665), "01:01:05");
    });
  });

  describe("3. GoogleDriveClient: listFiles", () => {
    it("solicita archivos no eliminados con fields y orden requeridos", async () => {
      let requestedUrl = null;
      let authHeader = null;

      const mockFetch = async (url, options = {}) => {
        const urlStr = String(url);
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "test_token", expires_in: 3600 })
          };
        }

        requestedUrl = urlStr;
        authHeader = options.headers?.Authorization;

        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [
              { id: "id1", name: "chunk_20261024_160005.mp4", size: "12345", mimeType: "video/mp4", createdTime: "2026-10-24T16:00:05Z" },
              { id: "id2", name: "chunk_20261024_161505.mp4", size: "67890", mimeType: "video/mp4", createdTime: "2026-10-24T16:15:05Z" }
            ]
          })
        };
      };

      const client = new GoogleDriveClient({
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rtoken",
        fetchFn: mockFetch
      });

      const files = await client.listFiles("test_folder_id");

      assert.strictEqual(authHeader, "Bearer test_token");
      assert.ok(requestedUrl.includes("q=%27test_folder_id%27+in+parents+and+trashed+%3D+false"));
      assert.ok(requestedUrl.includes("pageSize=1000"));
      assert.ok(requestedUrl.includes("orderBy=name"));
      assert.strictEqual(files.length, 2);
      assert.strictEqual(files[0].id, "id1");
      assert.strictEqual(files[0].name, "chunk_20261024_160005.mp4");
      assert.strictEqual(files[0].size, 12345);
      assert.strictEqual(files[1].size, 67890);
    });

    it("soporta paginación automática cuando hay nextPageToken", async () => {
      let pageCount = 0;

      const mockFetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "test_token", expires_in: 3600 })
          };
        }

        pageCount++;
        if (pageCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              nextPageToken: "token_page_2",
              files: [{ id: "file_p1", name: "chunk_p1.mp4", size: "100" }]
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ id: "file_p2", name: "chunk_p2.mp4", size: "200" }]
          })
        };
      };

      const client = new GoogleDriveClient({
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rtoken",
        fetchFn: mockFetch
      });

      const files = await client.listFiles("folder_paginated");
      assert.strictEqual(pageCount, 2);
      assert.strictEqual(files.length, 2);
      assert.strictEqual(files[0].name, "chunk_p1.mp4");
      assert.strictEqual(files[1].name, "chunk_p2.mp4");
    });
  });

  describe("4. GoogleDriveClient: downloadFile", () => {
    it("descarga archivo mediante stream y valida integridad y tamaño", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive_down_test_"));
      const destPath = path.join(tmpDir, "test_download.mp4");
      const fakeContent = Buffer.from("DATOS_DE_VIDEO_MP4_SIMULADOS_PARA_PRUEBA");

      let progressReports = [];
      const mockFetch = async (url, options = {}) => {
        const urlStr = String(url);
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "test_token", expires_in: 3600 })
          };
        }

        assert.ok(urlStr.includes("/files/mock_file_id?alt=media"));
        assert.strictEqual(options.headers?.Authorization, "Bearer test_token");

        return {
          ok: true,
          status: 200,
          headers: {
            get: (h) => (h.toLowerCase() === "content-length" ? String(fakeContent.length) : null)
          },
          body: Readable.from([fakeContent])
        };
      };

      const client = new GoogleDriveClient({
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rtoken",
        fetchFn: mockFetch
      });

      const res = await client.downloadFile("mock_file_id", destPath, {
        expectedSize: fakeContent.length,
        onProgress: (p) => progressReports.push(p)
      });

      assert.strictEqual(res.destPath, destPath);
      assert.strictEqual(res.size, fakeContent.length);
      assert.strictEqual(fs.existsSync(destPath), true);
      assert.strictEqual(fs.readFileSync(destPath, "utf-8"), "DATOS_DE_VIDEO_MP4_SIMULADOS_PARA_PRUEBA");
      assert.ok(progressReports.length > 0);
      assert.strictEqual(progressReports[progressReports.length - 1].downloadedBytes, fakeContent.length);

      // Limpieza
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("lanza error y purga archivo parcial si el archivo descargado está vacío (0 bytes)", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive_down_empty_"));
      const destPath = path.join(tmpDir, "empty.mp4");

      const mockFetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "test_token", expires_in: 3600 })
          };
        }

        return {
          ok: true,
          status: 200,
          headers: { get: () => "0" },
          body: Readable.from([]) // Stream vacío
        };
      };

      const client = new GoogleDriveClient({
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rtoken",
        fetchFn: mockFetch
      });

      await assert.rejects(
        () => client.downloadFile("empty_file_id", destPath),
        /corrupto o vacío \(0 bytes\)/
      );

      assert.strictEqual(fs.existsSync(destPath), false, "El archivo corrupto debe haberse eliminado");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("lanza error y purga archivo si el tamaño no coincide con el esperado", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive_down_mismatch_"));
      const destPath = path.join(tmpDir, "mismatch.mp4");

      const mockFetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "test_token", expires_in: 3600 })
          };
        }

        return {
          ok: true,
          status: 200,
          headers: { get: () => "100" }, // Content-length dice 100
          body: Readable.from([Buffer.from("SOLO_10_B")]) // Solo 9 bytes
        };
      };

      const client = new GoogleDriveClient({
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rtoken",
        fetchFn: mockFetch
      });

      await assert.rejects(
        () => client.downloadFile("mismatch_file_id", destPath, { expectedSize: 100 }),
        /no coincide con el esperado/
      );

      assert.strictEqual(fs.existsSync(destPath), false);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("5. Integración: downloadAndMergeDay (Dry Run con Mock)", () => {
    it("encuentra y lista chunks de ambas carpetas UTC en modo dry-run", async () => {
      const mockClient = {
        rootFolderName: "IOT_Camera_Recordings",
        async ensureRootFolder() {
          return "mock_root_id";
        },
        async findFolder(name, parentId) {
          if (name === "2026-10-24") return { id: "f24_id", name: "2026-10-24" };
          if (name === "2026-10-25") return { id: "f25_id", name: "2026-10-25" };
          return null;
        },
        async listFiles(folderId) {
          if (folderId === "f24_id") {
            return [
              { id: "c1", name: "chunk_20261024_010957.mp4", size: 5000 }, // Fuera (Día 23 Perú)
              { id: "c2", name: "chunk_20261024_160005.mp4", size: 10000 }, // 11:00 AM Perú
              { id: "c3", name: "chunk_20261024_220000.mp4", size: 12000 }  // 5:00 PM Perú
            ];
          }
          if (folderId === "f25_id") {
            return [
              { id: "c4", name: "chunk_20261025_011333.mp4", size: 15000 }, // 8:13 PM Perú del 24
              { id: "c5", name: "chunk_20261025_060000.mp4", size: 8000 }   // 1:00 AM Perú del 25 (Fuera)
            ];
          }
          return [];
        }
      };

      const result = await downloadAndMergeDay(
        {
          date: "2026-10-24",
          dryRun: true,
          tz: "America/Lima"
        },
        mockClient
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.totalChunks, 3);
      assert.strictEqual(result.chunks[0].name, "chunk_20261024_160005.mp4");
      assert.strictEqual(result.chunks[1].name, "chunk_20261024_220000.mp4");
      assert.strictEqual(result.chunks[2].name, "chunk_20261025_011333.mp4");
    });
  });

  describe("6. Barra de Progreso CLI: renderProgressBar", () => {
    it("renderiza correctamente 0%, 50% y 100% con valores de fracción (0..1) y porcentaje (0..100)", () => {
      // 0%
      assert.strictEqual(renderProgressBar(0, 20), `[${"░".repeat(20)}]`);
      assert.strictEqual(renderProgressBar(0.0, 20), `[${"░".repeat(20)}]`);

      // 50% como fracción 0.5 y como porcentaje 50
      assert.strictEqual(renderProgressBar(0.5, 20), `[${"█".repeat(10)}${"░".repeat(10)}]`);
      assert.strictEqual(renderProgressBar(50, 20), `[${"█".repeat(10)}${"░".repeat(10)}]`);

      // 100% como fracción 1.0 y como porcentaje 100
      assert.strictEqual(renderProgressBar(1.0, 20), `[${"█".repeat(20)}]`);
      assert.strictEqual(renderProgressBar(100, 20), `[${"█".repeat(20)}]`);
    });

    it("gestiona desbordamientos (overflow >100% o >1.0) limitando al 100%", () => {
      // Porcentajes > 100%
      assert.strictEqual(renderProgressBar(101, 20), `[${"█".repeat(20)}]`);
      assert.strictEqual(renderProgressBar(150, 20), `[${"█".repeat(20)}]`);
      assert.strictEqual(renderProgressBar(500, 20), `[${"█".repeat(20)}]`);
    });

    it("gestiona subdesbordamientos (underflow <0) limitando al 0%", () => {
      // Fracción negativa
      assert.strictEqual(renderProgressBar(-0.1, 20), `[${"░".repeat(20)}]`);
      assert.strictEqual(renderProgressBar(-1.0, 20), `[${"░".repeat(20)}]`);
      // Porcentaje negativo
      assert.strictEqual(renderProgressBar(-50, 20), `[${"░".repeat(20)}]`);
      assert.strictEqual(renderProgressBar(-100, 20), `[${"░".repeat(20)}]`);
    });

    it("soporta ancho y caracteres personalizados de relleno y vacío", () => {
      assert.strictEqual(renderProgressBar(0.5, 10, "=", "-"), "[=====-----]");
      assert.strictEqual(renderProgressBar(100, 5, "#", "."), "[#####]");
      assert.strictEqual(renderProgressBar(0, 5, "#", "."), "[.....]");
      assert.strictEqual(renderProgressBar(0.8, 5, "*", "_"), "[****_]");
    });

    it("maneja de forma segura valores nulos, indefinidos o NaN como 0%", () => {
      assert.strictEqual(renderProgressBar(NaN, 10), "[░░░░░░░░░░]");
      assert.strictEqual(renderProgressBar(null, 10), "[░░░░░░░░░░]");
      assert.strictEqual(renderProgressBar(undefined, 10), "[░░░░░░░░░░]");
    });
  });

  describe("7. Integración: Descarga y Manejo de Caché con Barras de Progreso", () => {
    it("emite barras de progreso dinámicas y detecta chunks en caché correctamente", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "day_progress_test_"));
      const chunksDir = path.join(tmpDir, "chunks");
      fs.mkdirSync(chunksDir, { recursive: true });

      // Chunk 1 ya existe en disco con el tamaño exacto (en caché)
      const cachedFile = path.join(chunksDir, "chunk_20261024_160005.mp4");
      fs.writeFileSync(cachedFile, Buffer.alloc(1000));

      const stdoutWrites = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = function (chunk, ...args) {
        stdoutWrites.push(String(chunk));
        return originalWrite.apply(process.stdout, [chunk, ...args]);
      };

      const mockClient = {
        rootFolderName: "IOT_Camera_Recordings",
        async ensureRootFolder() { return "mock_root"; },
        async findFolder(name) {
          if (name === "2026-10-24") return { id: "f24" };
          return null;
        },
        async listFiles() {
          return [
            { id: "c1", name: "chunk_20261024_160005.mp4", size: 1000 },
            { id: "c2", name: "chunk_20261024_161505.mp4", size: 2000 }
          ];
        },
        async downloadFile(fileId, destPath, options = {}) {
          if (typeof options.onProgress === "function") {
            options.onProgress({ downloadedBytes: 1000, totalBytes: 2000 });
            options.onProgress({ downloadedBytes: 2000, totalBytes: 2000 });
          }
          fs.writeFileSync(destPath, Buffer.alloc(2000));
          return { destPath, size: 2000 };
        }
      };

      try {
        await downloadAndMergeDay(
          {
            date: "2026-10-24",
            chunksDir,
            output: path.join(tmpDir, "out.mp4"),
            tz: "America/Lima"
          },
          mockClient
        );
      } catch (err) {
        // FFmpeg puede fallar en concatenar buffers simulados no válidos, lo cual es esperado
      } finally {
        process.stdout.write = originalWrite;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      const allOutput = stdoutWrites.join("");
      // 1. Verifica detección de chunk en caché
      assert.ok(allOutput.includes("[En caché] chunk_20261024_160005.mp4"), "Debe registrar chunk en caché");
      // 2. Verifica reporte de progreso global
      assert.ok(allOutput.includes("Global:"), "Debe mostrar barra de progreso Global");
      // 3. Verifica mensaje final de descarga previa a FFmpeg
      assert.ok(allOutput.includes("Todos los 2 chunks descargados (100%)"), "Debe confirmar descarga al 100%");
      // 4. Verifica resumen informativo de chunks y cobertura
      assert.ok(allOutput.includes("Total de chunks: 2"));
      assert.ok(allOutput.includes("Cobertura temporal estimada: 30 minutos (0.5 horas)"));
    });
  });
});
