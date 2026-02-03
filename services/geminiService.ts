import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { PhotoAnalysis } from "../types";

// 1. CLEANER: Strips Markdown from response
const cleanJSON = (text: string): string => {
  return text.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
};

export const analyzePhoto = async (base64Image: string): Promise<PhotoAnalysis> => {
  // 2. KEY CHECK: Reads the Vercel Variable
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("API KEY MISSING. Check Vercel Settings.");
    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0,
      reason: "MISSING KEY", keywords: [], caption: ""
    };
  }

  try {
    // 3. INITIALIZE: Uses the correct @google/generative-ai class
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      // Disable Safety Checks so it doesn't block people photos
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ]
    });

    const prompt = `
      Act as a professional photo editor. Analyze this image.
      Return a JSON object with this EXACT structure:
      {
        "rating": (Integer 0-5, 0=Reject, 5=Hero),
        "reason": (String, short reason),
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

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
    ]);

    const response = await result.response;
    const text = response.text();
    
    // Parse the clean JSON
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
    console.error("AI FAILURE:", error);
    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
      whites: 0, blacks: 0, contrast: 0, 
      reason: "AI ERROR", keywords: [], caption: ""
    };
  }
};
