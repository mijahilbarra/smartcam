/**
 * Analyze an image buffer using Google Gemini Vision API
 * @param {Buffer} imageBuffer 
 * @param {string} prompt 
 * @param {string} apiKey 
 * @param {string} model 
 * @returns {Promise<string>}
 */
export async function analyzeImageWithGemini(
  imageBuffer,
  prompt = "Describe what do you see in the image",
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || "gemini-flash-latest"
) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not defined");
  }

  const base64Data = imageBuffer.toString("base64");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  console.log(`[Gemini] Calling ${model} with prompt: "${prompt}"...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Data
              }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    console.warn("[Gemini] No text candidate found in response:", JSON.stringify(data));
    return "No analysis returned from model.";
  }

  console.log(`[Gemini] Analysis received (${text.length} chars)`);
  return text;
}
