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

  // 2. THE EXPANDED MODEL LIST (Includes Legacy Fallbacks)
  const MODELS_TO_TRY = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-001",
    "gemini-1.5-pro",
    "gemini-pro",        // <-- The "Old Faithful" (Most likely to work)
    "gemini-1.0-pro",    // <-- Explicit Legacy
    "gemini-pro-vision"  // <-- Older vision specific model
  ];

  const genAI = new GoogleGenerativeAI(apiKey);
  
  // 3. SAFETY: Uncensored
  const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ];

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

  // 4. LOOP
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
      
      // If we get here, it worked!
      console.log(`✅ SUCCESS with ${modelName}`);
      const data = JSON.parse(cleanJSON(text));
      
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
      
      // If this was the last model, return failure
      if (modelName === MODELS_TO_TRY[MODELS_TO_TRY.length - 1]) {
        let failReason = "ALL MODELS FAILED";
        if (error.message.includes("404")) failReason = "Models Not Found";
        if (error.message.includes("429")) failReason = "Quota Exceeded";
        
        return {
          rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
          whites: 0, blacks: 0, contrast: 0, 
          reason: failReason, keywords: [], caption: ""
        };
      }
    }
  }

  return { rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0, reason: "LOOP ERROR", keywords: [], caption: "" };
};
