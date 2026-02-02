import { GoogleGenAI, SchemaType, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

// Strict JSON schema to force the AI to behave like a database
const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: {
      type: Type.INTEGER,
      description: "Star rating from 0 to 5. 5: Hero shot. 4: Great. 3: Good. 2: Duplicate. 1: Poor. 0: Reject.",
    },
    exposure: {
      type: Type.NUMBER,
      description: "Lightroom Exposure EV offset (e.g., -0.5, 0.3).",
    },
    temp: {
      type: Type.NUMBER,
      description: "White Balance Temp offset (e.g., 200, -400).",
    },
    highlights: { type: Type.NUMBER },
    shadows: { type: Type.NUMBER },
    whites: { type: Type.NUMBER },
    blacks: { type: Type.NUMBER },
    contrast: { type: Type.NUMBER },
    reason: {
      type: Type.STRING,
      description: "Short aesthetic reasoning.",
    },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Descriptive keywords for search (e.g., 'bride', 'bokeh', 'sunset').",
    },
    caption: {
      type: Type.STRING,
      description: "A short, descriptive aesthetic summary.",
    }
  },
  required: ["rating", "exposure", "temp", "highlights", "shadows", "whites", "blacks", "contrast", "reason", "keywords", "caption"],
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  const MAX_ATTEMPTS = 3;
  // Use the correct stable model name
  const MODEL_NAME = 'gemini-1.5-flash';

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Act as a high-end commercial photo editor. Analyze this image aesthetically.\n\nSTRICT CULLING:\n- 0 STARS for out-of-focus, blurry, or rubbish shots.\n- 5 STARS for incredible composition and emotion.\n- Preserve MOOD: If moody/low-key, keep it dark.\n\nMETADATA:\nProvide descriptive keywords and a short caption." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      }
    });

    const text = response.text || "{}";
    const result = JSON.parse(text);
    
    // Ensure we always return at least a default object if AI misses fields
    return {
      rating: result.rating ?? 3, // Default to 3 stars if unsure
      exposure: result.exposure ?? 0,
      temp: result.temp ?? 0,
      highlights: result.highlights ?? 0,
      shadows: result.shadows ?? 0,
      whites: result.whites ?? 0,
      blacks: result.blacks ?? 0,
      contrast: result.contrast ?? 0,
      reason: result.reason ?? "AI_ANALYSIS_COMPLETE",
      keywords: result.keywords ?? [],
      caption: result.caption ?? "Processed by Novus Cura"
    };

  } catch (error: any) {
    console.error("Gemini API Error:", error);
    
    const isRateLimit = error?.status === 429 || error?.message?.includes('429');

    if (isRateLimit && attempt < MAX_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      console.warn(`Rate limit hit. Retrying in ${Math.round(delay)}ms...`);
      await wait(delay);
      return analyzePhoto(base64Image, attempt + 1);
    }

    // Fallback if AI fails completely
    return {
      rating: 0,
      exposure: 0,
      temp: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      contrast: 0,
      reason: "API_FAILURE",
      keywords: ["error"],
      caption: "Analysis failed due to network or API limit."
    };
  }
};
