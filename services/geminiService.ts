import { GoogleGenAI, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: { type: Type.INTEGER, description: "Rating 0-5. 5=Hero, 0=Reject." },
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

// Helper to clean Markdown like ```json ... ```
const cleanJSON = (text: string): string => {
  return text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
};

export const analyzePhoto = async (base64Image: string): Promise<PhotoAnalysis> => {
  // 1. Get the Key (Must match Vercel)
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("CRITICAL ERROR: API Key is missing.");
    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
      whites: 0, blacks: 0, contrast: 0, 
      reason: "MISSING API KEY (Check Vercel Settings)", keywords: [], caption: ""
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    // 2. Use the Correct Model
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Act as a pro photo editor. Rate 0-5. 0 if blurry. 5 if perfect. Return valid JSON." }
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

    const result = JSON.parse(cleanJSON(rawText));

    return {
      ...result,
      contrast: result.contrast ?? 0
    } as PhotoAnalysis;

  } catch (error: any) {
    console.error("AI Error:", error);
    let failReason = "AI Analysis Failed";
    
    if (error.message?.includes("403")) failReason = "Invalid API Key";
    if (error.message?.includes("404")) failReason = "Model Not Found";
    if (error.message?.includes("429")) failReason = "Quota Exceeded";

    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
      whites: 0, blacks: 0, contrast: 0, 
      reason: failReason, keywords: [], caption: ""
    };
  }
};
