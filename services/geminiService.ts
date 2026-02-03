import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { PhotoAnalysis } from "../types";

// 1. ROBUST CLEANER: Handle messy API responses
const cleanJSON = (text: string): string => {
  // Remove markdown code blocks
  let clean = text.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
  return clean.trim();
};

export const analyzePhoto = async (base64Image: string): Promise<PhotoAnalysis> => {
  // 1. Get API Key
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
  
  if (!apiKey) {
    console.error("❌ API KEY MISSING: Please check Vercel Settings -> Environment Variables -> VITE_GEMINI_API_KEY");
    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0,
      reason: "MISSING API KEY", keywords: [], caption: ""
    };
  }

  try {
    const genAI = new GoogleGenAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      // 2. CRITICAL: DISABLE SAFETY FILTERS (This fixes the "people" blocking issue)
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ]
    });

    // 3. Simple, Direct Prompt
    const prompt = `
      Act as a professional photo editor. Analyze this image metadata and aesthetics.
      Return a JSON object with this EXACT structure (do not add markdown):
      {
        "rating": (Integer 0-5, 0=Reject, 5=Hero),
        "reason": (String, why you gave this rating),
        "exposure": (Number, EV offset e.g. 0.5),
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

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
    ]);

    const response = await result.response;
    const text = response.text();
    
    console.log("✅ AI RAW RESPONSE:", text); // Check your Browser Console (F12) to see this!

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
      reason: data.reason || "Processed",
      keywords: Array.isArray(data.keywords) ? data.keywords : [],
      caption: data.caption || ""
    };

  } catch (error: any) {
    // 4. REAL ERROR LOGGING
    console.error("❌ AI FAILURE:", error);
    
    let failReason = "AI Error";
    if (error.message?.includes("403")) failReason = "Bad API Key";
    if (error.message?.includes("429")) failReason = "Rate Limit (Too Fast)";
    if (error.message?.includes("503")) failReason = "Server Busy";
    if (error.message?.includes("SAFETY")) failReason = "Safety Block";

    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
      whites: 0, blacks: 0, contrast: 0, 
      reason: failReason, keywords: [], caption: ""
    };
  }
};
