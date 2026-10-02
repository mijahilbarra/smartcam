# ADR 05: Análisis Visual Multimodal con Google Gemini Vision AI

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El propósito fundamental del sistema no es solo almacenar fotogramas de vigilancia, sino interpretar inteligentemente qué está ocurriendo en la barbería en cada momento:
* Identificar personas, personal o clientes presentes.
* Detectar el estado del local (abierto, cerrado, persiana metálica enrollable abajo o arriba).
* Reconocer elementos y objetos específicos (sillón de barbero, poste de barbero, extintor, monitor de TV, etc.).
* Permitir ajustar la consigna de análisis ("prompt") en cualquier momento para buscar patrones específicos (ej. contar personas, detectar anomalías de seguridad o verificar orden).

---

## Decisión Técnica

Se integró **Google Gemini Vision** a través de la API oficial de Google AI Studio / Generative Language (`v1beta`):

1. **Modelo Seleccionado**:
   * `gemini-flash-latest` (que resuelve dinámicamente a la versión más avanzada y rápida de Gemini Flash, como Gemini 1.5 Flash / Gemini 3.8 Flash).
   * **Razón**: Posee una latencia de respuesta de apenas 1 a 2 segundos, comprensión visual multimodal de vanguardia y un costo mínimo por millón de tokens.
2. **Método de Invocación**:
   * Se utiliza el endpoint REST oficial:
     `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
   * La imagen recién capturada en memoria se codifica en Base64 y se envía en el cuerpo de la petición como `inlineData`:
     ```json
     {
       "contents": [
         {
           "parts": [
             { "text": promptText },
             {
               "inlineData": {
                 "mimeType": "image/jpeg",
                 "data": base64String
               }
             }
           ]
         }
       ]
     }
     ```
3. **Inyección Dinámica del Prompt**:
   * En lugar de tener una instrucción estática en el código, el daemon consulta en cada captura el documento `camera_catcher/prompt` de Firestore. Si el usuario actualizó el prompt desde el panel web, la siguiente captura utilizará inmediatamente la nueva instrucción.

---

## Consecuencias

### Positivas:
* Comprensión contextual de altísima precisión: Gemini identifica correctamente carteles ("perrosuelto"), la hora superpuesta de la cámara, objetos especializados de barbería y el estado de la cortina metálica.
* Cero infraestructura de Machine Learning que mantener: no se requieren GPUs dedicadas ni servidores de inferencia pesados en la nube.
* Flexibilidad total para cambiar el caso de uso cambiando únicamente una línea de texto en el dashboard.
