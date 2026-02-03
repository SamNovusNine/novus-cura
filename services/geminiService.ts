import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { PhotoAnalysis } from "../types";

// 1. HELPER: Clean JSON
const cleanJSON = (text: string): string => {
  return text.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
};

export const analyzePhoto = async (base64Image: string): Promise<PhotoAnalysis> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ API KEY MISSING");
    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0,
      reason: "MISSING API KEY", keywords: [], caption: ""
    };
  }

  // 2. MODEL LIST: The "Self-Healing" Order
  // We try 'gemini-pro' FIRST because it is the most widely available.
  const MODELS_TO_TRY = [
    "gemini-1.5-flash",        // Fast, new
    "gemini-1.5-flash-latest", // Bleeding edge
    "gemini-1.5-pro",          // Powerful
    "gemini-pro",              // Old faithful (Legacy v1.0)
    "gemini-1.0-pro"           // Explicit Legacy
  ];

  const genAI = new GoogleGenerativeAI(apiKey);
  
  // 3. SAFETY: Disable filters so it doesn't block "people"
  const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ];

  // 4. THE PROMPT
  const prompt = `
    Act as a professional photo editor. Analyze this image.
    Return a JSON object with this EXACT structure (no markdown):
    {
      "rating": (Integer 0-5, 0=Reject, 5=Hero),
      "reason": (String, short technical reason),
      "exposure": (Number, EV offset),
      "temp": (Number, WB offset),
      "highlights": (Number),
      "shadows": (Number),
      "whites": (Number),
      "blacks": (Number),
      "contrast": (Number),
      "keywords": [String array],
      "caption": (String)
    }
  `;

  // 5. TRY LOOP
  for (const modelName of MODELS_TO_TRY) {
    try {
      console.log(`🤖 Trying Model: ${modelName}...`);
      
      const model = genAI.getGenerativeModel({ model: modelName, safetySettings });

      const result = await model.generateContent([
        prompt,
        { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
      ]);

      const response = await result.response;
      const text = response.text();
      const data = JSON.parse(cleanJSON(text));

      console.log(`✅ SUCCESS with ${modelName}`);
      
      return {
        rating: typeof data.rating === 'number' ? data.rating : 0,
        exposure: data.exposure || 0,
        temp: data.temp || 0,
        highlights: data.highlights || 0,
        shadows: data.shadows || 0,
        whites: data.whites || 0,
        blacks: data.blacks || 0,
        contrast: data.contrast || 0,
        reason: data.reason || `Analyzed by ${modelName}`,
        keywords: Array.isArray(data.keywords) ? data.keywords : [],
        caption: data.caption || ""
      };

    } catch (error: any) {
      console.warn(`⚠️ Failed with ${modelName}:`, error.message);
      
      // If we ran out of models, fail.
      if (modelName === MODELS_TO_TRY[MODELS_TO_TRY.length - 1]) {
        return {
          rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
          whites: 0, blacks: 0, contrast: 0, 
          reason: "ALL MODELS FAILED", keywords: [], caption: ""
        };
      }
    }
  }

  return { rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0, reason: "LOOP ERROR", keywords: [], caption: "" };
};
