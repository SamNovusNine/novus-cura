import { GoogleGenAI, SchemaType, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

// 1. The Contract (Schema)
const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: {
      type: Type.INTEGER,
      description: "Rating 0-5. 5=Hero, 4=Great, 3=Good, 0=Reject (Blurry/Bad).",
    },
    exposure: { type: Type.NUMBER },
    temp: { type: Type.NUMBER },
    highlights: { type: Type.NUMBER },
    shadows: { type: Type.NUMBER },
    whites: { type: Type.NUMBER },
    blacks: { type: Type.NUMBER },
    contrast: { type: Type.NUMBER },
    reason: { type: Type.STRING },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    caption: { type: Type.STRING }
  },
  required: ["rating", "exposure", "reason", "keywords", "caption"],
};

// 2. Helper: Clean "Markdown" garbage from API response
const cleanJSON = (text: string): string => {
  return text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  const MAX_ATTEMPTS = 3;
  // FIXED: Use the stable model that works in AI Studio
  const MODEL_NAME = 'gemini-1.5-flash';

  try {
    // Check all possible environment variable locations for Vercel/Vite
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.API_KEY;
    
    if (!apiKey) throw new Error("Missing API Key. Check Vercel Settings.");

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Act as a pro photo editor. Rate this image (0-5). 0 if blurry. 5 if perfect. Provide Lightroom edits." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      }
    });

    const rawText = response.text();
    if (!rawText) throw new Error("Empty response");

    // Clean formatting before parsing
    const cleanedText = cleanJSON(rawText);
    const result = JSON.parse(cleanedText);

    return {
      rating: result.rating ?? 0,
      exposure: result.exposure ?? 0,
      temp: result.temp ?? 0,
      highlights: result.highlights ?? 0,
      shadows: result.shadows ?? 0,
      whites: result.whites ?? 0,
      blacks: result.blacks ?? 0,
      contrast: result.contrast ?? 0,
      reason: result.reason ?? "Processed",
      keywords: result.keywords ?? [],
      caption: result.caption ?? ""
    };

  } catch (error: any) {
    console.error("AI Error:", error);
    
    // Retry logic
    if (attempt < MAX_ATTEMPTS) {
      await wait(2000 * attempt);
      return analyzePhoto(base64Image, attempt + 1);
    }

    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
      whites: 0, blacks: 0, contrast: 0, 
      reason: "API_FAIL", keywords: [], caption: "Analysis Failed"
    };
  }
};
