# Tareas Pendientes (TODO) - IOT Camera Catcher

Este archivo lista iniciativas, mejoras técnicas y tareas futuras planificadas para el sistema.

---

## 📋 Backlog de Tareas

### 1. Integración de Facturación Real de Google Cloud (BigQuery Billing Export)
* **Prioridad**: Baja / Exploratoria
* **Área**: FinOps & Monitoreo
* **Objetivo**: Conectar la facturación oficial y exacta emitida por Google Cloud directamente en el panel web, mostrando los dólares y centavos reales facturados por SKU en lugar de solo proyecciones calculadas.

#### Contexto Técnico:
Google Cloud no expone una API REST directa para consultar la factura en tiempo real por proyecto. La vía oficial y estándar recomendada por Google es la exportación automática de costos hacia BigQuery.

#### Pasos para la Implementación:
1. **Activar Exportación en Google Cloud Console**:
   - Navegar a **Facturación (Billing)** > **Exportación de Facturación (Billing export)** en la cuenta `Keepers` (`014EA3-44BBE1-6CF18A`).
   - Activar la exportación de "Costos de uso estándar" o "Costos de uso detallados" hacia un dataset en el proyecto `skip-bigotes` (ej. `skip-bigotes:gcp_billing_export`).
2. **Consultas Agregadas**:
   - Crear una consulta SQL programada o endpoint en el daemon que ejecute:
     ```sql
     SELECT
       service.description AS service_name,
       sku.description AS sku_name,
       SUM(cost) AS total_cost_usd,
       currency
     FROM `skip-bigotes.gcp_billing_export.gcp_billing_export_v1_014EA3_44BBE1_6CF18A`
     WHERE usage_start_time >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), MONTH)
       AND project.id = 'skip-bigotes'
     GROUP BY 1, 2, 4
     ORDER BY total_cost_usd DESC;
     ```
3. **Sincronización con Firestore / Panel Web**:
   - Guardar el resultado agregado diariamente en un documento `camera_catcher/billing_actual`.
   - Mostrar en el panel web una columna comparativa: **"Facturado Oficial Google"** vs **"Proyección Preventiva"**.
