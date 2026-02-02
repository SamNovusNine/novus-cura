import { GoogleGenAI, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: { type: Type.INTEGER },
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
  required: ["rating", "reason", "keywords", "caption"],
};

const cleanJSON = (text: string): string => {
  return text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  // Use the standard Flash model
  const MODEL_NAME = 'gemini-1.5-flash';

  try {
    // 1. ROBUST KEY CHECK: Look everywhere for the key
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
    
    if (!apiKey) {
        // If missing, return specific error to UI
        return {
            rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0,
            reason: "MISSING API KEY (Check Vercel Env Vars)", keywords: [], caption: ""
        };
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Rate image 0-5. 5=Best. Return valid JSON." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      }
    });

    const rawText = response.text();
    if (!rawText) throw new Error("Empty AI Response");

    const cleanedText = cleanJSON(rawText);
    const result = JSON.parse(cleanedText);

    return {
      ...result,
      reason: result.reason || "Processed Successfully",
      contrast: result.contrast ?? 0
    } as PhotoAnalysis;

  } catch (error: any) {
    console.error("Full AI Error:", error);
    
    // 2. ERROR EXPOSURE: Return the actual error message to the UI
    let errorMessage = "Unknown Error";
    
    if (error.message) errorMessage = error.message;
    if (error.status === 403) errorMessage = "403: Invalid API Key";
    if (error.status === 429) errorMessage = "429: Rate Limit Exceeded";
    if (error.status === 503) errorMessage = "503: Model Overloaded";

    return {
      rating: 0,
      exposure: 0, temp: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0,
      reason: `FAIL: ${errorMessage}`, // This will show on the card
      keywords: [],
      caption: "Analysis Failed"
    };
  }
};
